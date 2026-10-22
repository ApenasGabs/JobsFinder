#!/usr/bin/env python3
import sys
import json
import zipfile
import xml.etree.ElementTree as ET
import urllib.request
import re
from urllib.parse import urlparse, unquote

def download_if_google_sheets(source: str) -> str:
    """Se for URL do Google Sheets, converte para export XLSX e baixa para arquivo temporário."""
    m = re.search(r"docs\.google\.com/spreadsheets/d/([a-zA-Z0-9\-_]+)", source)
    if m:
        doc_id = m.group(1)
        export_url = f"https://docs.google.com/spreadsheets/d/{doc_id}/export?format=xlsx"
        tmp_path = f"/tmp/sheet_{doc_id}.xlsx"
        req = urllib.request.Request(export_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            with open(tmp_path, "wb") as f:
                f.write(resp.read())
        return tmp_path
    return source

def parse_xlsx(file_path: str, max_tabs: int = 0):
    z = zipfile.ZipFile(file_path)

    # 1. Shared Strings
    shared_strings = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}si"):
            text = "".join(t.text or "" for t in si.findall(".//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t"))
            shared_strings.append(text)

    # 2. Workbook / Abas
    wb_root = ET.fromstring(z.read("xl/workbook.xml"))
    sheets = []
    for s in wb_root.findall(".//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}sheet"):
        sheet_name = s.attrib.get("name")
        sheet_id = s.attrib.get("sheetId")
        sheets.append((sheet_name, sheet_id))

    if max_tabs > 0:
        sheets = sheets[:max_tabs]

    all_rows = []

    for idx, (sheet_name, sid) in enumerate(sheets, start=1):
        sheet_file = f"xl/worksheets/sheet{idx}.xml"
        rels_file = f"xl/worksheets/_rels/sheet{idx}.xml.rels"

        if sheet_file not in z.namelist():
            continue

        hyperlinks = {}
        if rels_file in z.namelist():
            rels_root = ET.fromstring(z.read(rels_file))
            for rel in rels_root.findall("{http://schemas.openxmlformats.org/package/2006/relationships}Relationship"):
                if "hyperlink" in rel.attrib.get("Type", ""):
                    hyperlinks[rel.attrib.get("Id")] = rel.attrib.get("Target")

        s_root = ET.fromstring(z.read(sheet_file))
        cell_links = {}
        for hl in s_root.findall(".//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}hyperlink"):
            ref = hl.attrib.get("ref")
            hl_id = hl.attrib.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
            if ref and hl_id and hl_id in hyperlinks:
                cell_links[ref] = hyperlinks[hl_id]

        for row in s_root.findall(".//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}row"):
            cols = {}
            for c in row.findall("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}c"):
                ref = c.attrib.get("r", "")
                col = "".join(filter(str.isalpha, ref))
                t = c.attrib.get("t")
                v = c.find("{http://schemas.openxmlformats.org/spreadsheetml/2006/main}v")
                val = ""
                if v is not None and v.text is not None:
                    val = shared_strings[int(v.text)] if (t == "s" and int(v.text) < len(shared_strings)) else v.text
                link = cell_links.get(ref, "")
                cols[col] = {"val": val.strip(), "link": link}

            # Normalização de Linha
            # Layout A (Vagas): Coluna B=Empresa, C=Vaga, D=Categoria, E=Link
            # Layout B (Empresas para conferir): Coluna B=VagasCount, C=Website, D=GoogleSearch, E=LinkedInSearch
            company = cols.get("B", {}).get("val", "")
            job_title = cols.get("C", {}).get("val", "")
            category = cols.get("D", {}).get("val", "")
            link = cols.get("E", {}).get("link") or cols.get("D", {}).get("link") or cols.get("C", {}).get("link") or cols.get("B", {}).get("link") or ""

            # Detectar se é Layout B (onde a coluna D ou E tem google/linkedin search e C tem website)
            google_search = cols.get("D", {}).get("link", "")
            linkedin_search = cols.get("E", {}).get("link", "")
            website = cols.get("C", {}).get("link", "")

            if "google.com/search" in google_search or "linkedin.com/jobs" in linkedin_search:
                extracted_name = ""
                if google_search:
                    m = re.search(r"[?&]q=([^&]+)", google_search)
                    if m:
                        raw = unquote(m.group(1).replace("+", " "))
                        extracted_name = re.sub(r"\s+vagas\s+carreiras.*$", "", raw, flags=re.IGNORECASE).strip()
                elif linkedin_search:
                    m = re.search(r"[?&]keywords=([^&]+)", linkedin_search)
                    if m:
                        extracted_name = unquote(m.group(1).replace("+", " ")).strip()

                if extracted_name:
                    all_rows.append({
                        "sheet": sheet_name,
                        "company": extracted_name,
                        "job_title": "Oportunidades em Tecnologia",
                        "category": "Geral",
                        "link": website or google_search,
                        "website": website,
                        "count": int(cols.get("B", {}).get("val", "0")) if cols.get("B", {}).get("val", "").isdigit() else 1
                    })
                    continue

            # Layout A normal
            if company and not any(skip in company.lower() for skip in ["empresa", "planilhão", "vagas por", "link", "categoria"]):
                all_rows.append({
                    "sheet": sheet_name,
                    "company": company,
                    "job_title": job_title,
                    "category": category,
                    "link": link,
                    "website": "",
                    "count": 1
                })

    return {
        "sheets_count": len(sheets),
        "sheets": [s[0] for s in sheets],
        "total_rows": len(all_rows),
        "rows": all_rows
    }

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Uso: xlsx-extractor.py <caminho_ou_url_planilha> [max_tabs]"}))
        sys.exit(1)

    source = sys.argv[1]
    max_tabs = int(sys.argv[2]) if len(sys.argv) > 2 else 0

    try:
        real_file = download_if_google_sheets(source)
        res = parse_xlsx(real_file, max_tabs)
        print(json.dumps(res, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
