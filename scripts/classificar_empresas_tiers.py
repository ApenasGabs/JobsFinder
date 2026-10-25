#!/usr/bin/env python3
"""
classificar_empresas_tiers.py
Avalia e classifica as 2.553 empresas cadastradas em empresas_carreiras_centralizadas.xlsx
em 3 Tiers operacionais de monitoramento:
- Tier 1 (Critico / Alta Frequencia - Diario): 1.000+ funcionarios ou 15+ vagas ativas constantes.
- Tier 2 (Medio Porte / Moderado - 2x a 3x/semana): 100 a 1.000 funcionarios ou 4 a 14 vagas abertas.
- Tier 3 (Pequeno Porte / Sob Demanda - Quinzenal): Menos de 100 funcionarios ou contratacoes pontuais.

Diretrizes:
1. Rate-limiting defensivo com pausas e jitter (1.5s - 3.0s) entre requisicoes HTTP por worker.
2. Checkpoints incrementais salvos a cada lote em data/empresas_headcount_tiers.json.
3. Prioriza chamadas leves HTTP/APIs (Next.js SSR da Gupy, Greenhouse JSON, InHire API, Ashby, Lever, Workday, Solides)
   com suporte opcional a Browserless CDP (ws://192.168.31.4:9222?token=kraken_cdp_secret).
"""
import argparse
import concurrent.futures
import json
import os
import random
import re
import shutil
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone

import consolidar_empresas_carreiras as consolidar

BASE_DIR = "/workspace/busca-vagas"
XLSX_PATH = os.path.join(BASE_DIR, "empresas_carreiras_centralizadas.xlsx")
CHECKPOINT_PATH = os.path.join(BASE_DIR, "data", "empresas_headcount_tiers.json")
JOBSFINDER_CHECKPOINT_PATH = os.path.join(BASE_DIR, "JobsFinder", "data", "empresas_headcount_tiers.json")
JOBS_JSON_PATH = os.path.join(BASE_DIR, "JobsFinder", "data", "jobs.json")
BROWSERLESS_WS = "ws://192.168.31.4:9222?token=kraken_cdp_secret"

# Conhecimento curado de empresas de Grande Porte (1.000+ funcionários -> Tier 1)
KNOWN_TIER1_KEYWORDS = {
    "itau", "bradesco", "santander", "nubank", "banco do brasil", "caixa economica", "btg pactual",
    "b3", "xp inc", "xp investimentos", "c6 bank", "banco pan", "banco bv", "banco inter", "inter",
    "agibank", "sicredi", "sicoob", "unicred", "banrisul", "banco bmg", "bmg", "daycoval", "safra",
    "mercadolivre", "mercado livre", "ifood", "totvs", "stefanini", "ci&t", "ciandt", "accenture",
    "ibm", "globo", "rede globo", "localiza", "grupo boticario", "boticario", "magazineluiza",
    "magazine luiza", "luizalabs", "luiza labs", "raia drogasil", "droga raia", "drogasil", "rd saude",
    "petrobras", "vale", "embraer", "stone", "pagseguro", "pagbank", "cielo", "rede", "getnet",
    "vivo", "telefonica", "claro", "tim", "oi", "algar", "brisanet", "desktop", "unifique",
    "porto seguro", "sulamerica", "tokio marine", "mapfre", "allianz", "liberty", "zurich", "icatuseguros",
    "dasa", "rede dor", "fleury", "grupo fleury", "albert einstein", "hospital israelita", "sirio libanes",
    "hapvida", "notredame", "unimed", "amil", "prevent senior", "sabin", "hermes pardini", "oncoclinicas",
    "natura", "avon", "gerdau", "suzano", "klabin", "weg", "marcopolo", "random", "tramontina",
    "ambev", "heineken", "coca cola", "pepsico", "nestle", "unilever", "pg", "procter", "mondelez",
    "kraft heinz", "brf", "jbs", "marfrig", "minerva", "aurora", "cargill", "bunge", "amaggi",
    "serasa", "experian", "thomson reuters", "salesforce", "sap", "oracle", "microsoft", "google",
    "amazon", "aws", "meta", "apple", "netflix", "uber", "99", "didiglobal", "spotify", "airbnb",
    "dell", "hewlett packard", "hp", "lenovo", "samsung", "lg", "motorola", "ericsson", "huawei",
    "tcs", "tata consultancy", "capgemini", "atos", "cognizant", "wipro", "infosys", "hcl", "ntt data",
    "everis", "indra", "minsait", "luxoft", "thoughtworks", "globant", "endava", "epam", "avanade",
    "deloitte", "pwc", "ey", "ernst young", "kpmg", "mckinsey", "bcg", "bain",
    "compass uol", "compasso", "uol", "zup", "avenue code", "act digital", "brq", "cast group",
    "cwi", "db1", "sinqia", "linx", "senior sistemas", "positivo", "intelbras", "multilaser",
    "madeiramadeira", "quintoandar", "creditas", "neon", "picpay", "wellhub", "gympass", "wildlife",
    "vtex", "loft", "loggi", "kavak", "olx", "grupo olx", "zap", "catho", "infojobs", "gupy",
    "locaweb", "lwsa", "movile", "unico", "dock", "pismo", "cloudwalk", "stark bank", "ebanz", "ebanx",
    "dlocal", "hotmart", "eduzz", "kiwify", "rd station", "resultados digitais", "conta azul", "omie",
    "bling", "tiny", "sankhya", "alterdata", "mega sistemas", "softplan", "betha", "mv sistemas",
    "philips", "siemens", "bosch", "schneider", "abb", "ge", "general electric", "honeywell", "3m",
    "basf", "bayer", "syngenta", "yara", "mosaic", "raizen", "ultragaz", "ipiranga", "vibra",
    "cosan", "rumo", "ccr", "ecorodovias", "localfrotas", "unidas", "movida", "vamos", "jsl", "simpar",
    "azul", "gol", "latam", "cvc", "decolar", "despegar", "befly", "hurb", "123milhas",
    "carrefour", "atacadao", "assai", "pao de acucar", "gpa", "casas bahia", "via varejo", "americanas",
    "renner", "lojas renner", "riachuelo", "guararapes", "cea", "c&a", "marisa", "arezzo", "grupo soma",
    "alpargatas", "grendene", "vulcabras", "centauro", "grupo sbf", "netshoes", "dafiti", "kanui",
    "petz", "cobasi", "petlove", "leroy merlin", "telhanorte", "obramax", "vivara", "hstern",
    "kroton", "cogna", "yduqs", "estacio", "anima", "ser educacional", "cruzeiro do sul", "afya",
    "vitru", "unicesumar", "puc", "fgv", "insper", "senac", "senai", "sebrae", "sesc", "sesi",
    "aec", "atento", "teleperformance", "concentrix", "almaviva", "konecta", "uranet", "neobpo", "tivit",
    "algar tech", "callink", "plansul", "tahto", "paschoalotto", "bellinati", "recovery", "ativos",
    "equatorial", "neoenergia", "cpfl", "engie", "edp", "enel", "light", "cemig", "copel", "celesc",
    "sabesp", "aegea", "iguatemi", "multiplan", "alliansce", "br malls", "cyrela", "mrv", "tenda",
    "even", "eztec", "direcional", "plano&plano", "cury", "tegma", "sequoia", "total express",
    "jadlog", "braspress", " Jamef", "patrus", "tnt", "fedex", "dhl", "ups", "maersk", "msc",
    "cma cgm", "wilson sons", "santos brasil", "dp world", "klabin", "votorantim", "csn", "usiminas",
    "arcelormittal", "cbmm", "samarco", "anglo american", "kinross", "yamana", "nexa", "cba",
    "ache", "eurofarma", "ems", "hypera", "cristalia", "biolabo", "uniao quimica", "cimed", "prati",
    "libbs", "pfizer", "roche", "novartis", "sanofi", "astrazeneca", "gsk", "merck", "johnson",
    "takeda", "abbvie", "lilly", "novo nordisk", "boehringer", "pague menos", "panvel", "dpsp",
    "extrabom", "mateus", "grupo mateus", "supermercados", "koch", "angeloni", "condor", "muffato",
    "savegnago", "super nosso", "zona sul", "prezunic", "cencosud", "dia", "big", "walmart",
    "openai", "palantir", "stripe", "databricks", "snowflake", "cloudflare", "datadog", "crowdstrike",
    "twilio", "okta", "zscaler", "palo alto", "fortinet", "cisco", "vmware", "broadcom", "nvidia",
    "amd", "intel", "qualcomm", "arm", "canonical", "red hat", "suse", "gitlab", "github", "atlassian",
    "notion", "figma", "canva", "miro", "slack", "zoom", "shopify", "hubspot", "zendesk", "freshworks",
    "servicenow", "workday", "autodesk", "adobe", "intuit", "docuSign", "dropbox", "box", "pinterest",
    "reddit", "discord", "roblox", "unity", "epic games", "electronic arts", "ubisoft", "riot games",
    "brex", "robinhood", "coinbase", "binance", "mercado bitcoin", "bitso", "ripio", "foxbit",
}

# Conhecimento curado de empresas de Médio Porte (100 a 1.000 funcionários -> Tier 2)
KNOWN_TIER2_KEYWORDS = {
    "a3data", "ae studio", "akad", "applaudo", "armac", "bix", "blend it", "blueshift", "bulk",
    "capitani", "contabilizei", "cora", "flash", "gupy", "inhire", "solides", "quickin", "abler",
    "pandape", "recrut.ai", "mindsight", "selecty", "vagas.com", "geekhunter", "programathor",
    "coodesh", "revelo", "bossabox", "impulso", "vulpi", "trampos", "remotar", "apinfo",
    "asaas", "celcoin", "iugu", "pagarme", "pagar.me", "vindi", "zoop", "konduto", "clearsale",
    "unico", "idwall", "caf", "combate a fraude", "neoway", "bigdatacorp", "cortex", "zeeng",
    "involves", "exact sales", "meetime", "ramper", "moskit", "ploomes", "nectar", "agendor",
    "piperun", "rd", "leadlovers", "lahar", "dinamize", "e-goi", "zenvia", "take blip", "blip",
    "gupshup", "infobip", "sinch", "botmaker", "octadesk", "movidesk", "huggy", "hi platform",
    "neoassist", "desk manager", "tiflux", "milvus", "elaw", "projuris", "aurum", "jusbrasil",
    "digesto", "netlex", "clicksign", "d4sign", "zapSign", "certisign", "soluti", "safeweb",
    "arquivei", "qive", "conube", "agilize", "contabilivre", "omie", "vhsys", "kyte", "marketup",
    "nex", "consumer", "saipos", "anota ai", "goomer", "cardapio web", "delivery much", "aiqfome",
    "james", "rappi", "loggi", "mottu", "lalamove", "cobli", "softruck", "gobrax", "fretebras",
    "frete.com", "cargo x", "cargox", "truckpad", "buser", "clickbus", "guiche virtual", "embarca",
    "maxmilhas", "voopter", "passagens promo", "melhores destinos", "zarpo", "instaviagem",
    "onfly", "voll", "paytrack", "espresso", "flash", "caju", "swile", "eva", "vee", "alelo",
    "sodexo", "pluxee", "ticket", "vr", "ben", "up brasil", "zenklub", "vittude", "psicologia viva",
    "telavita", "alice", "sami", "kovi", "turbi", "awto", "moobie", "zul", "estapar", "sem parar",
    "veloe", "conectcar", "taggy", "gringo", "instaCarro", "volanty", "olho no carro", "karvi",
    "autoavaliar", "mobiauto", "icarros", "webmotors", "chaves na mao", "imovelweb", "vivareal",
    "olx", "netimoveis", "arbo", "credipronto", "cashme", "barigui", "pontte", "bcredi",
    "provu", "geru", "rebel", "bizcapital", "gyra", "nexoos", "kavak", "trocafone", "allugator",
    "housi", "tabas", "casai", "charlie", "nomah", "yuca", "uliving", "luggo", "morada",
    "amaro", "insider", "basico", "pantys", "linus", "sallve", "creamy", "boca rosa", "quem disse",
    "oceane", "simple organic", "biossance", "manual", "dr. jones", "evino", "wine", "grand cru",
    "divvino", "clube do malte", "zattini", "epoca cosmeticos", "beleza na web", "sephora",
    "rocketseat", "alura", "fiap", "trybe", "driven", "cubos academy", "kenzie", "ebac", "tera",
    "descomplica", "estrategia", "gran cursos", "qconcursos", "passei direto", "responde ai",
    "stoodi", "me salva", "kuadro", "geekie", "arvore", "eleva", "arco", "sas", "sae", "bernoulli",
    "poliedro", "anglo", "objetivo", "etapa", "mackenzie", "faap", "espm", "ibmek", "impatto",
    "dextra", "daitan", "eldorado", "cpqd", "cesar", "venturus", "fit", "sidia", "atlantico",
    "indt", "lactec", "certi", "softex", "matera", "sensedia", "vertigo", "ilegra", "south system",
    "meta", "metait", "e-core", "ecore", "bairesdev", "encora", "gorilla logic", "wizeline",
    "jalasoft", "toptal", "turing", "andela", "vanHack", "strider", "husky", "remessa online",
    "nomad", "avenue", "wise", "payoneer", "deel", "remote", "oyster", "ontop",
    "vetta", "evolux", "asksuite", "edrone", "camunda", "bonifiq", "accesstage", "apdata",
}


def norm_text(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii").lower()
    s = re.sub(r"[^a-z0-9\s&.]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def load_jobsfinder_counts() -> dict:
    counts = Counter()
    if os.path.exists(JOBS_JSON_PATH):
        try:
            with open(JOBS_JSON_PATH, encoding="utf-8") as f:
                jobs = json.load(f)
            for j in jobs:
                comp = j.get("company", "").strip()
                if comp:
                    counts[norm_text(comp)] += 1
        except Exception:
            pass
    return counts


def probe_ats_url(url: str, platform: str, timeout: int = 7) -> dict:
    """
    Faz chamada HTTP leve / API para descobrir vagas abertas em tempo real e indícios de headcount.
    Não consome cota de LLM.
    """
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "application/json, text/html, */*",
    }
    plat_lower = platform.lower()
    result = {"probed": False, "live_jobs": None, "headcount_hint": None, "method": "none"}

    try:
        # 1. Gupy (Next.js SSR __NEXT_DATA__)
        if "gupy" in plat_lower or ".gupy.io" in url:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                html = resp.read().decode("utf-8", errors="ignore")
            m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html)
            if m:
                nd = json.loads(m.group(1))
                page_props = nd.get("props", {}).get("pageProps", {})
                jobs = page_props.get("jobs", [])
                result["probed"] = True
                result["live_jobs"] = len(jobs)
                result["method"] = "gupy_nextjs_ssr"
                # Tentar extrair menção a número de colaboradores na descrição da empresa
                desc = json.dumps(page_props.get("company", {}), ensure_ascii=False)
                hm = re.search(r"(\d{1,3}(?:\.\d{3})+|\d{3,5})\s*(?:\+|mais de)?\s*(?:colaboradores|funcion[aá]rios|pessoas|talentos)", desc, re.IGNORECASE)
                if hm:
                    val = int(hm.group(1).replace(".", ""))
                    if 20 <= val <= 500000:
                        result["headcount_hint"] = val
                return result

        # 2. Greenhouse JSON API
        if "greenhouse" in plat_lower or "greenhouse.io" in url:
            m = re.search(r"greenhouse\.io/(?:embed/job_board\?for=)?([a-zA-Z0-9_-]+)", url)
            if m:
                slug = m.group(1)
                api_url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs"
                req = urllib.request.Request(api_url, headers=headers)
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    data = json.loads(resp.read().decode("utf-8", errors="ignore"))
                result["probed"] = True
                result["live_jobs"] = len(data.get("jobs", []))
                result["method"] = "greenhouse_api"
                return result

        # 3. InHire API
        if "inhire" in plat_lower or "inhire.app" in url:
            m = re.search(r"https?://([a-zA-Z0-9_-]+)\.inhire\.app", url)
            if m:
                slug = m.group(1)
                inhire_headers = dict(headers)
                inhire_headers.update({
                    "X-Tenant": slug,
                    "Origin": f"https://{slug}.inhire.app",
                    "Referer": f"https://{slug}.inhire.app/",
                })
                req = urllib.request.Request("https://api.inhire.app/job-posts/public/pages", headers=inhire_headers)
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    data = json.loads(resp.read().decode("utf-8", errors="ignore"))
                jobs_page = data.get("jobsPage", [])
                pub_jobs = [j for j in jobs_page if j.get("status", "published").lower() == "published"]
                result["probed"] = True
                result["live_jobs"] = len(pub_jobs)
                result["method"] = "inhire_api"
                return result

        # 4. Ashby API
        if "ashby" in plat_lower or "ashbyhq.com" in url:
            m = re.search(r"ashbyhq\.com/([a-zA-Z0-9_.-]+)", url)
            if m:
                slug = m.group(1).strip("/")
                api_url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}"
                req = urllib.request.Request(api_url, headers=headers)
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    data = json.loads(resp.read().decode("utf-8", errors="ignore"))
                result["probed"] = True
                result["live_jobs"] = len(data.get("jobs", []))
                result["method"] = "ashby_api"
                return result

        # 5. Lever JSON API
        if "lever" in plat_lower or "lever.co" in url:
            m = re.search(r"lever\.co/([a-zA-Z0-9_.-]+)", url)
            if m:
                slug = m.group(1).strip("/")
                api_url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
                req = urllib.request.Request(api_url, headers=headers)
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    data = json.loads(resp.read().decode("utf-8", errors="ignore"))
                if isinstance(data, list):
                    result["probed"] = True
                    result["live_jobs"] = len(data)
                    result["method"] = "lever_api"
                    return result

        # 6. Recruitee JSON API
        if "recruitee" in plat_lower or "recruitee.com" in url:
            m = re.search(r"https?://([a-zA-Z0-9_-]+)\.recruitee\.com", url)
            if m:
                slug = m.group(1)
                api_url = f"https://{slug}.recruitee.com/api/offers"
                req = urllib.request.Request(api_url, headers=headers)
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    data = json.loads(resp.read().decode("utf-8", errors="ignore"))
                result["probed"] = True
                result["live_jobs"] = len(data.get("offers", []))
                result["method"] = "recruitee_api"
                return result

    except Exception:
        pass

    return result


def classify_company(row: dict, jf_counts: dict, live_probe: dict) -> dict:
    name = row.get("A", "")
    url = row.get("B", "")
    platform = row.get("C", "")
    website = row.get("D", "")
    hist_vagas = int(row.get("G", "0") or 0)
    modalidades = row.get("H", "")
    cidades = [c.strip() for c in row.get("I", "").split(",") if c.strip()]
    toxica = row.get("J", "Não") == "Sim"
    mencoes_toxicas = int(row.get("K", "0") or 0)
    aliases = row.get("L", "")

    n_clean = norm_text(name)
    jf_vagas = jf_counts.get(n_clean, 0)
    live_vagas = live_probe.get("live_jobs")
    headcount_hint = live_probe.get("headcount_hint")

    # Vagas ativas efetivas (maior valor entre live probe, jobs.json e histórico recente ponderado)
    active_vagas = max(
        live_vagas if live_vagas is not None else 0,
        jf_vagas,
        hist_vagas,
    )

    is_known_tier1 = any(
        kw == n_clean or (len(kw) >= 5 and kw in n_clean)
        for kw in KNOWN_TIER1_KEYWORDS
    )
    is_known_tier2 = any(
        kw == n_clean or (len(kw) >= 5 and kw in n_clean)
        for kw in KNOWN_TIER2_KEYWORDS
    )

    # Heurística estrutural de Porte & Tier:
    # Tier 1: 1.000+ funcionários OU 15+ vagas ativas constantes
    # Tier 2: 100 a 1.000 funcionários OU 4 a 14 vagas abertas
    # Tier 3: Menos de 100 funcionários OU contratações pontuais (0 a 3 vagas)
    reasons = []
    if headcount_hint and headcount_hint >= 1000:
        tier = "Tier 1"
        porte = f"Grande Porte ({headcount_hint}+ funcionários)"
        reasons.append(f"headcount SSR ({headcount_hint})")
    elif active_vagas >= 15:
        tier = "Tier 1"
        porte = "Grande Porte / Alta Demanda (1.000+ func. ou 15+ vagas)"
        reasons.append(f"{active_vagas} vagas mapeadas")
    elif is_known_tier1 or platform in ("Workday", "Eightfold", "SmartRecruiters") or mencoes_toxicas >= 8:
        tier = "Tier 1"
        porte = "Grande Porte (1.000+ funcionários)"
        if is_known_tier1:
            reasons.append("Enterprise reconhecida (1.000+ func.)")
        elif platform in ("Workday", "Eightfold", "SmartRecruiters"):
            reasons.append(f"ATS Enterprise ({platform})")
        else:
            reasons.append(f"Alto volume de relatos corporativos ({mencoes_toxicas})")
    elif (headcount_hint and 100 <= headcount_hint < 1000) or (4 <= active_vagas <= 14):
        tier = "Tier 2"
        porte = "Médio Porte (100 a 1.000 funcionários)"
        if 4 <= active_vagas <= 14:
            reasons.append(f"{active_vagas} vagas abertas/históricas")
        if headcount_hint:
            reasons.append(f"headcount SSR ({headcount_hint})")
    elif (
        is_known_tier2
        or platform not in ("LinkedIn Jobs", "Google Careers", "")
        or len(cidades) >= 2
        or mencoes_toxicas >= 3
        or (website and modalidades)
    ):
        tier = "Tier 2"
        porte = "Médio Porte (100 a 1.000 funcionários)"
        if is_known_tier2:
            reasons.append("Scale-up / Médio Porte reconhecida")
        elif platform not in ("LinkedIn Jobs", "Google Careers", ""):
            reasons.append(f"Portal ATS dedicado ({platform})")
        elif len(cidades) >= 2:
            reasons.append(f"Presença multi-cidade ({len(cidades)} polos)")
        elif mencoes_toxicas >= 3:
            reasons.append(f"Múltiplos relatos ({mencoes_toxicas})")
        else:
            reasons.append("Website oficial + modalidade estruturada")
    else:
        tier = "Tier 3"
        porte = "Pequeno Porte (< 100 funcionários)"
        reasons.append("Contratações pontuais / Sob demanda")

    freq_map = {
        "Tier 1": "Diário (Alta Frequência)",
        "Tier 2": "2x a 3x por semana (Moderado)",
        "Tier 3": "Quinzenal (Sob Demanda)",
    }

    return {
        "company": name,
        "career_url": url,
        "platform": platform,
        "website": website,
        "tier": tier,
        "porte": porte,
        "monitoring_frequency": freq_map[tier],
        "metrics": {
            "effective_jobs": active_vagas,
            "live_ats_jobs": live_vagas,
            "jobsfinder_active_jobs": jf_vagas,
            "historical_cscx_jobs": hist_vagas,
            "toxic_mentions": mencoes_toxicas,
            "cities_count": len(cidades),
            "headcount_hint": headcount_hint,
        },
        "probe_method": live_probe.get("method", "none"),
        "classification_reasons": reasons,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }


def save_checkpoint(results_dict: dict, total_expected: int):
    os.makedirs(os.path.dirname(CHECKPOINT_PATH), exist_ok=True)
    items = list(results_dict.values())
    tier_counts = Counter(i["tier"] for i in items)
    payload = {
        "metadata": {
            "total_companies_target": total_expected,
            "processed_count": len(items),
            "progress_percent": round((len(items) / max(total_expected, 1)) * 100, 2),
            "tier_summary": {
                "Tier 1": tier_counts.get("Tier 1", 0),
                "Tier 2": tier_counts.get("Tier 2", 0),
                "Tier 3": tier_counts.get("Tier 3", 0),
            },
            "browserless_endpoint": BROWSERLESS_WS,
            "last_checkpoint_at": datetime.now(timezone.utc).isoformat(),
        },
        "companies": items,
    }
    tmp_path = CHECKPOINT_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, CHECKPOINT_PATH)

    if os.path.exists(os.path.dirname(JOBSFINDER_CHECKPOINT_PATH)):
        shutil.copy2(CHECKPOINT_PATH, JOBSFINDER_CHECKPOINT_PATH)


def main():
    parser = argparse.ArgumentParser(description="Classifica as 2.553 empresas em 3 Tiers operacionais.")
    parser.add_argument("--batch-size", type=int, default=50, help="Tamanho do lote para salvar checkpoint incremental")
    parser.add_argument("--delay-min", type=float, default=1.5, help="Delay mínimo (s) com jitter entre chamadas HTTP por worker")
    parser.add_argument("--delay-max", type=float, default=3.0, help="Delay máximo (s) com jitter entre chamadas HTTP por worker")
    parser.add_argument("--workers", type=int, default=12, help="Workers concorrentes para sondagem defensiva de APIs ATS")
    parser.add_argument("--limit-probes", type=int, default=180, help="Limite de sondagens HTTP ao vivo por execução (0 = todas ATS)")
    parser.add_argument("--reset", action="store_true", help="Ignora checkpoint anterior e reprocessa do zero")
    args = parser.parse_args()

    # Garantir que a planilha consolidada está com as 2.553 empresas
    rows = consolidar.load_base_rows(XLSX_PATH)
    if len(rows) < 2553:
        print(f"Atualizando planilha base ({len(rows)} -> 2.553 empresas)...")
        consolidar.merge_and_save()
        rows = consolidar.load_base_rows(XLSX_PATH)

    total_companies = len(rows)
    print(f"📋 Total de empresas carregadas de empresas_carreiras_centralizadas.xlsx: {total_companies}")

    jf_counts = load_jobsfinder_counts()
    print(f"🔎 Empresas com vagas ativas em JobsFinder/data/jobs.json: {len(jf_counts)}")

    existing_results = {}
    if not args.reset and os.path.exists(CHECKPOINT_PATH):
        try:
            with open(CHECKPOINT_PATH, encoding="utf-8") as f:
                cp = json.load(f)
            for item in cp.get("companies", []):
                if item.get("company"):
                    existing_results[item["company"]] = item
            print(f"♻️ Checkpoint existente carregado: {len(existing_results)} empresas já avaliadas.")
        except Exception:
            pass

    # Selecionar empresas com APIs leves (Gupy, Greenhouse, Inhire, Ashby, Lever, Recruitee) para probing HTTP defensivo
    probe_candidates = []
    for r in rows:
        name = r.get("A", "")
        plat = r.get("C", "")
        if name in existing_results and existing_results[name].get("probe_method", "none") != "none":
            continue
        if plat in ("Gupy", "Greenhouse", "Inhire", "Ashby", "Lever", "Recruitee"):
            probe_candidates.append(r)

    if args.limit_probes > 0:
        # Priorizar empresas que ainda não têm 15+ vagas históricas conhecidas
        probe_candidates.sort(key=lambda r: int(r.get("G", "0") or 0), reverse=True)
        probe_candidates = probe_candidates[: args.limit_probes]

    print(
        f"🌐 Iniciando sondagem leve HTTP/API para {len(probe_candidates)} portais ATS "
        f"(rate-limit jitter: {args.delay_min}s-{args.delay_max}s por worker)..."
    )

    live_probes = {}
    lock = threading.Lock()
    probed_counter = 0

    def worker_probe(r):
        nonlocal probed_counter
        # Rate-limiting defensivo com jitter (1.5s a 3.0s)
        time.sleep(random.uniform(args.delay_min, args.delay_max))
        res = probe_ats_url(r.get("B", ""), r.get("C", ""))
        with lock:
            live_probes[r["A"]] = res
            probed_counter += 1
            if probed_counter % args.batch_size == 0 or probed_counter == len(probe_candidates):
                # Atualizar resultados parciais e salvar checkpoint incremental
                for row_item in rows:
                    c_name = row_item["A"]
                    if c_name in live_probes or c_name not in existing_results:
                        p_data = live_probes.get(c_name, {"probed": False, "live_jobs": None, "headcount_hint": None, "method": "none"})
                        existing_results[c_name] = classify_company(row_item, jf_counts, p_data)
                save_checkpoint(existing_results, total_companies)
                print(f"💾 [Checkpoint] Sondadas {probed_counter}/{len(probe_candidates)} APIs ATS | Total classificado: {len(existing_results)}/{total_companies}")

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        list(executor.map(worker_probe, probe_candidates))

    # Classificar todas as 2.553 empresas em lotes incrementais e persistir no checkpoint + Excel
    print("📊 Consolidando classificação final das 2.553 empresas em lotes...")
    for idx, r in enumerate(rows, start=1):
        c_name = r["A"]
        p_data = live_probes.get(c_name)
        if not p_data and c_name in existing_results and existing_results[c_name].get("probe_method", "none") != "none":
            p_data = {
                "probed": True,
                "live_jobs": existing_results[c_name]["metrics"].get("live_ats_jobs"),
                "headcount_hint": existing_results[c_name]["metrics"].get("headcount_hint"),
                "method": existing_results[c_name].get("probe_method", "none"),
            }
        elif not p_data:
            p_data = {"probed": False, "live_jobs": None, "headcount_hint": None, "method": "none"}

        info = classify_company(r, jf_counts, p_data)
        existing_results[c_name] = info

        # Preencher colunas M, N, O, P na planilha
        r["M"] = f"{info['tier']} ({info['monitoring_frequency']})"
        r["N"] = info["porte"]
        r["O"] = str(info["metrics"]["effective_jobs"])
        r["P"] = info["monitoring_frequency"]

        if idx % args.batch_size == 0 or idx == total_companies:
            save_checkpoint(existing_results, total_companies)

    # Salvar planilha Excel atualizada com as colunas de Tier e Porte
    consolidar.write_xlsx(consolidar.BACKUP_XLSX, XLSX_PATH, rows)

    tier_counts = Counter(item["tier"] for item in existing_results.values())
    print("\n==========================================================================")
    print("✅ Classificação de Tiers & Porte Concluída com Sucesso!")
    print("==========================================================================")
    print(f"🏢 Total de Empresas Classificadas: {len(existing_results)}")
    print(f"🔥 Tier 1 (Crítico / Diário - 1.000+ func. ou 15+ vagas):     {tier_counts.get('Tier 1', 0)}")
    print(f"⚡ Tier 2 (Médio Porte / 2x-3x sem. - 100-1.000 func./4-14v): {tier_counts.get('Tier 2', 0)}")
    print(f"🌱 Tier 3 (Pequeno Porte / Quinzenal - <100 func./pontual):   {tier_counts.get('Tier 3', 0)}")
    print(f"💾 Checkpoint JSON: {CHECKPOINT_PATH}")
    print(f"📊 Planilha Atualizada: {XLSX_PATH}")


if __name__ == "__main__":
    main()
