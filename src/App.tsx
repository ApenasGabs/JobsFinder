import {
  Activity,
  Briefcase,
  Building,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Cpu,
  Download,
  ExternalLink,
  FileText,
  Layers,
  MapPin,
  MessageSquare,
  Play,
  QrCode,
  Radio,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings,
  Trash2,
  X
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  workModel: 'REMOTO' | 'HIBRIDO' | 'PRESENCIAL' | 'NAO_INFORMADO';
  salary?: string;
  contractType: 'CLT' | 'PJ' | 'FREELANCER' | 'ESTAGIO' | 'OUTRO';
  seniorityLevel: string;
  url: string;
  source: string;
  stack: string[];
  scrapedAt: string;
  description?: string;
  notifiedAt?: string | null;
}

interface AppConfig {
  searchTerms: string[];
  seniorityLevels: string[];
  contractTypes: string[];
  sources: Array<{ id: string; name: string; type: string; enabled: boolean }>;
  gupyCompanies: Array<{ name: string; link: string; slug: string; enabled: boolean }>;
  inhireCompanies?: Array<{ name: string; link: string; slug: string; enabled: boolean }>;
  ashbyCompanies?: Array<{ name: string; link: string; slug: string; enabled: boolean }>;
  leverCompanies?: Array<{ name: string; link: string; slug: string; enabled: boolean }>;
  greenhouseCompanies?: Array<{ name: string; link: string; slug: string; enabled: boolean }>;
  workableCompanies?: Array<{ name: string; link: string; slug: string; enabled: boolean }>;
  whatsapp?: {
    enabled: boolean;
    targetGroupJid: string;
    targetGroupName?: string;
    sendDigestIfMoreThan: number;
    targetCategories?: string[];
    batchSize?: number;
    batchIntervalMinutes?: number;
  };
  scheduler?: {
    enabled: boolean;
    cronSchedule: string;
    lastRunAt?: string;
  };
}

interface WhatsAppStatus {
  status: 'disconnected' | 'connecting' | 'connected';
  botNumber: string | null;
  qrCode: string | null;
  enabled: boolean;
  targetGroupJid: string;
  targetGroupName?: string;
  targetCategories?: string[];
  queuePendingCount?: number;
  isProcessingQueue?: boolean;
  nextBatchRemainingSeconds?: number;
}

export default function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [totalJobs, setTotalJobs] = useState(0);
  const [stats, setStats] = useState<any>({});
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [health, setHealth] = useState<any>(null);

  // WhatsApp & Scheduler state
  const [waStatus, setWaStatus] = useState<WhatsAppStatus>({
    status: 'disconnected',
    botNumber: null,
    qrCode: null,
    enabled: false,
    targetGroupJid: '',
    targetCategories: ['TODAS'],
    queuePendingCount: 0,
    isProcessingQueue: false,
    nextBatchRemainingSeconds: 0
  });
  const [groups, setGroups] = useState<Array<{ id: string; subject: string; participants: number }>>([]);
  const [selectedGroupJid, setSelectedGroupJid] = useState('');
  const [groupSearch, setGroupSearch] = useState('');
  const [isSavingGroup, setIsSavingGroup] = useState(false);
  const [groupSaveMsg, setGroupSaveMsg] = useState<string | null>(null);
  const [isLoadingGroups, setIsLoadingGroups] = useState(false);
  const hasLoadedGroupsRef = useRef(false);
  const [showQrModal, setShowQrModal] = useState(false);
  const [testSending, setTestSending] = useState(false);
  const [testResultMsg, setTestResultMsg] = useState<string | null>(null);

  // Disparo manual por categoria e controle de fila
  const [dispatchCategory, setDispatchCategory] = useState('ESTAGIO');
  const [pendingCategoryCount, setPendingCategoryCount] = useState(0);
  const [isDispatching, setIsDispatching] = useState(false);
  const [dispatchResultMsg, setDispatchResultMsg] = useState<string | null>(null);
  const [isSavingCategories, setIsSavingCategories] = useState(false);
  const [categorySaveMsg, setCategorySaveMsg] = useState<string | null>(null);

  // Filtros de busca local
  const [searchFilter, setSearchFilter] = useState('');
  const [modelFilter, setModelFilter] = useState('ALL');
  const [contractFilter, setContractFilter] = useState('ALL');
  const [sourceFilter, setSourceFilter] = useState('ALL');
  const [notifiedFilter, setNotifiedFilter] = useState<'ALL' | 'PENDING' | 'NOTIFIED'>('ALL');
  const [onlyTechFilter, setOnlyTechFilter] = useState(true);
  const [isPurging, setIsPurging] = useState(false);
  const [purgeResultMsg, setPurgeResultMsg] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // Sistema de Auditoria & Logs
  const [showLogsModal, setShowLogsModal] = useState(false);
  const [logs, setLogs] = useState<any[]>([]);
  const [logStats, setLogStats] = useState<any>(null);
  const [isLoadingLogs, setIsLoadingLogs] = useState(false);
  const [logCategoryFilter, setLogCategoryFilter] = useState<'ALL' | 'CLASSIFIER' | 'WHATSAPP' | 'CRAWLER' | 'USER_ACTION' | 'ERRORS'>('ALL');
  const [logSearch, setLogSearch] = useState('');
  const [expandedLogIds, setExpandedLogIds] = useState<Record<string, boolean>>({});

  // Parâmetros de execução do crawler
  const [selectedTerms, setSelectedTerms] = useState<string[]>(['java', 'react', 'node']);
  const [selectedSources, setSelectedSources] = useState<string[]>(['GUPY', 'INHIRE', 'ASHBY', 'LEVER', 'GREENHOUSE', 'WORKABLE', 'REMOTEOK', 'PROGRAMATHOR', 'FREELAS_99', 'GEEKHUNTER']);
  const [newCustomTerm, setNewCustomTerm] = useState('');

  // Estado da execução / SSE
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeProgress, setScrapeProgress] = useState<{
    message: string;
    percent?: number;
    currentCompany?: string;
    totalFound: number;
  }>({ message: 'Pronto para iniciar busca', percent: 0, totalFound: 0 });

  const [showConfigModal, setShowConfigModal] = useState(false);
  const [configModalTab, setConfigModalTab] = useState<'GUPY' | 'INHIRE' | 'ASHBY' | 'LEVER' | 'GREENHOUSE' | 'WORKABLE'>('GUPY');
  const [configSearchTerm, setConfigSearchTerm] = useState('');
  const eventSourceRef = useRef<EventSource | null>(null);

  // Carrega dados iniciais
  useEffect(() => {
    loadHealth();
    loadConfig();
    loadJobs();
    loadStats();
    loadWhatsAppStatus();
    loadPendingCount(dispatchCategory);
    loadLogStats();

    const interval = setInterval(() => {
      loadHealth();
      loadWhatsAppStatus();
      loadPendingCount(dispatchCategory);
      loadLogStats();
    }, 5000);

    return () => clearInterval(interval);
  }, [dispatchCategory]);

  const loadPendingCount = async (cat = dispatchCategory) => {
    try {
      const res = await fetch(`/api/jobs/pending-count?category=${encodeURIComponent(cat)}`);
      if (res.ok) {
        const data = await res.json();
        setPendingCategoryCount(data.count ?? 0);
      }
    } catch {
      // Falha silenciosa
    }
  };

  const loadHealth = async () => {
    try {
      const res = await fetch('/api/health');
      if (res.ok) setHealth(await res.json());
    } catch {
      // Servidor offline ou iniciando
      // Servidor iniciando
    }
  };

  const loadConfig = async () => {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const data: AppConfig = await res.json();
        setConfig(data);
        if (data.searchTerms?.length > 0) {
          setSelectedTerms(data.searchTerms.slice(0, 5));
        }
      }
    } catch (err) {
      console.error('Erro ao carregar config:', err);
    }
  };

  const loadJobs = async (
    source = sourceFilter,
    search = searchFilter,
    model = modelFilter,
    contract = contractFilter,
    notified = notifiedFilter,
    onlyTech = onlyTechFilter,
    page = currentPage,
    size = pageSize
  ) => {
    try {
      const params = new URLSearchParams();
      if (source && source !== 'ALL') params.append('source', source);
      if (search && search.trim()) params.append('search', search.trim());
      if (model && model !== 'ALL') params.append('workModel', model);
      if (contract && contract !== 'ALL') params.append('contractType', contract);
      if (notified && notified !== 'ALL') params.append('notified', notified);
      if (onlyTech) params.append('onlyTech', 'true');
      params.append('page', String(page));
      params.append('pageSize', String(size));

      const res = await fetch(`/api/jobs?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs || []);
        setTotalJobs(data.total || 0);
      }
    } catch (err) {
      console.error('Erro ao carregar vagas:', err);
    }
  };

  useEffect(() => {
    loadJobs(sourceFilter, searchFilter, modelFilter, contractFilter, notifiedFilter, onlyTechFilter, currentPage, pageSize);
  }, [sourceFilter, searchFilter, modelFilter, contractFilter, notifiedFilter, onlyTechFilter, currentPage, pageSize]);

  const loadStats = async () => {
    try {
      const res = await fetch('/api/stats');
      if (res.ok) setStats(await res.json());
    } catch (err) {
      console.error('Erro ao carregar estatísticas:', err);
    }
  };

  const loadWhatsAppStatus = async () => {
    try {
      const res = await fetch('/api/whatsapp/status');
      if (res.ok) {
        const data: WhatsAppStatus = await res.json();
        setWaStatus(data);
        if (data.targetGroupJid) {
          setSelectedGroupJid((prev) => prev || data.targetGroupJid || '');
        }
        // Carrega grupos apenas uma vez na conexão inicial para não estourar rate limit
        if (data.status === 'connected' && !hasLoadedGroupsRef.current) {
          hasLoadedGroupsRef.current = true;
          loadWhatsAppGroups(false);
        }
      }
    } catch {
      // Ignora silenciosamente
    }
  };

  const loadWhatsAppGroups = async (force = false) => {
    setIsLoadingGroups(true);
    try {
      const res = await fetch('/api/whatsapp/groups' + (force ? '?force=true' : ''));
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.groups) && data.groups.length > 0) {
          setGroups(data.groups);
        }
      }
    } catch (err) {
      console.error('Erro ao carregar grupos WhatsApp:', err);
    } finally {
      setIsLoadingGroups(false);
    }
  };

  const filteredGroups = useMemo(() => {
    const normalize = (str: string) =>
      str
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

    let list = [...groups];
    if (groupSearch.trim()) {
      const term = normalize(groupSearch.trim());
      list = list.filter((g) => normalize(g.subject || '').includes(term));
    }
    // Ordenação alfabética em português (A-Z) para fácil localização
    list.sort((a, b) =>
      (a.subject || '').localeCompare(b.subject || '', 'pt-BR', { sensitivity: 'base' })
    );
    return list;
  }, [groups, groupSearch]);

  const handleSaveGroup = async () => {
    if (!selectedGroupJid) return;
    setIsSavingGroup(true);
    setGroupSaveMsg(null);
    try {
      const selected = groups.find((g) => g.id === selectedGroupJid);
      const groupName = selected?.subject || waStatus.targetGroupName || 'Grupo Selecionado';
      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: true,
          targetGroupJid: selectedGroupJid,
          targetGroupName: groupName
        })
      });
      if (res.ok) {
        setGroupSaveMsg(`✅ Grupo "${groupName}" salvo e mantido como destino das vagas!`);
        await loadWhatsAppStatus();
        await loadConfig();
        setTimeout(() => setGroupSaveMsg(null), 6000);
      } else {
        setGroupSaveMsg('❌ Erro ao salvar grupo no servidor.');
      }
    } catch (err: any) {
      console.error('Erro ao salvar grupo WhatsApp:', err);
      setGroupSaveMsg(`❌ Erro: ${err?.message || 'Falha ao salvar'}`);
    } finally {
      setIsSavingGroup(false);
    }
  };

  const handleTestWhatsApp = async () => {
    setTestSending(true);
    setTestResultMsg(null);
    try {
      const res = await fetch('/api/whatsapp/test', { method: 'POST' });
      const data = await res.json();
      setTestResultMsg(data.message || (data.success ? 'Mensagem enviada com sucesso!' : 'Falha ao enviar'));
    } catch (err: any) {
      setTestResultMsg(`Erro: ${err?.message || 'Falha de conexão'}`);
    } finally {
      setTestSending(false);
    }
  };

  const handleDispatchCategory = async () => {
    setIsDispatching(true);
    setDispatchResultMsg(null);
    try {
      const res = await fetch('/api/whatsapp/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category: dispatchCategory })
      });
      const data = await res.json();
      setDispatchResultMsg(data.message || (data.enqueued ? `${data.enqueued} vagas enfileiradas!` : 'Disparo concluído'));
      await loadWhatsAppStatus();
      await loadJobs();
      await loadPendingCount(dispatchCategory);
      setTimeout(() => setDispatchResultMsg(null), 8000);
    } catch (err: any) {
      setDispatchResultMsg(`Erro: ${err?.message || 'Falha ao disparar vagas'}`);
    } finally {
      setIsDispatching(false);
    }
  };

  const handleToggleJobNotified = async (jobId: string, currentNotified: boolean) => {
    // Atualização otimista imediata na UI
    const newNotifiedAt = currentNotified ? null : new Date().toISOString();
    setJobs((prev) =>
      prev.map((j) => (j.id === jobId ? { ...j, notifiedAt: newNotifiedAt } : j))
    );
    try {
      const res = await fetch(`/api/jobs/${jobId}/notified`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notified: !currentNotified })
      });
      if (!res.ok) {
        await loadJobs();
      } else {
        loadPendingCount(dispatchCategory);
      }
    } catch {
      await loadJobs();
    }
  };

  const handlePurgeNonTech = async () => {
    if (
      !window.confirm(
        "Deseja executar o expurgo de vagas não-tech? O sistema criará um backup de segurança e removerá todas as vagas que não forem de TI do banco ativo."
      )
    ) {
      return;
    }
    setIsPurging(true);
    setPurgeResultMsg(null);
    try {
      const res = await fetch('/api/jobs/purge-non-tech', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setPurgeResultMsg(`🧹 Expurgadas ${data.purgedCount} vagas fora de TI! Restam ${data.remainingCount} vagas ativas.`);
        loadJobs();
        loadStats();
      } else {
        alert("Erro ao executar expurgo.");
      }
    } catch (err: any) {
      alert("Falha na requisição: " + (err?.message || err));
    } finally {
      setIsPurging(false);
    }
  };

  const handleMarkNotTech = async (job: Job) => {
    if (!window.confirm(`Tem certeza que deseja marcar "${job.title}" como NÃO-TI? Ela será removida da lista e o classificador aprenderá a decisão.`)) {
      return;
    }
    try {
      const res = await fetch('/api/classifier/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId: job.id, title: job.title, isTech: false })
      });
      if (res.ok) {
        setJobs((prev) => prev.filter((j) => j.id !== job.id));
        setTotalJobs((prev) => Math.max(0, prev - 1));
        loadStats();
      }
    } catch (err) {
      console.error('Erro ao registrar feedback não-tech:', err);
    }
  };

  const handleToggleTargetCategory = async (cat: string) => {
    const currentCats = waStatus.targetCategories || ['TODAS'];
    let newCats: string[];
    if (cat === 'TODAS') {
      newCats = currentCats.includes('TODAS') ? ['ESTAGIO'] : ['TODAS'];
    } else {
      const filtered = currentCats.filter((c) => c !== 'TODAS' && c !== 'ALL');
      if (filtered.includes(cat)) {
        newCats = filtered.filter((c) => c !== cat);
        if (newCats.length === 0) newCats = ['TODAS'];
      } else {
        newCats = [...filtered, cat];
      }
    }

    setIsSavingCategories(true);
    setCategorySaveMsg(null);
    try {
      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetCategories: newCats
        })
      });
      if (res.ok) {
        setWaStatus((prev) => ({ ...prev, targetCategories: newCats }));
        setCategorySaveMsg('Categorias salvas com sucesso!');
        setTimeout(() => setCategorySaveMsg(null), 4000);
      }
    } catch (err: any) {
      console.error('Erro ao salvar categorias automáticas:', err);
    } finally {
      setIsSavingCategories(false);
    }
  };

  // Inicia a varredura com streaming em tempo real (SSE)
  const startScrape = () => {
    if (isScraping) return;

    setIsScraping(true);
    setScrapeProgress({
      message: 'Conectando ao mecanismo de scraping...',
      percent: 5,
      totalFound: 0
    });

    const queryParams = new URLSearchParams({
      keywords: selectedTerms.join(','),
      sources: selectedSources.join(',')
    });

    const sse = new EventSource(`/api/scrape/stream?${queryParams.toString()}`);
    eventSourceRef.current = sse;

    sse.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);

        if (event.type === 'start') {
          setScrapeProgress({
            message: event.message || 'Iniciando varredura...',
            percent: 10,
            totalFound: 0
          });
        } else if (event.type === 'progress') {
          setScrapeProgress((prev) => ({
            ...prev,
            message: event.message || prev.message,
            percent: event.progressPercent || prev.percent,
            currentCompany: event.currentCompany
          }));
        } else if (event.type === 'job' && event.job) {
          // Adiciona a vaga recebida em tempo real no topo da lista
          setJobs((prev) => {
            const exists = prev.some((j) => j.id === event.job.id);
            if (exists) return prev;
            return [event.job, ...prev];
          });
          setScrapeProgress((prev) => ({
            ...prev,
            totalFound: event.totalFound || prev.totalFound + 1
          }));
        } else if (event.type === 'done') {
          setScrapeProgress((prev) => ({
            ...prev,
            message: event.message || 'Varredura finalizada com sucesso!',
            percent: 100,
            totalFound: event.totalFound || prev.totalFound
          }));
          setIsScraping(false);
          sse.close();
          loadStats();
          loadJobs();
        } else if (event.type === 'error') {
          setScrapeProgress((prev) => ({
            ...prev,
            message: `Erro: ${event.message}`
          }));
          setIsScraping(false);
          sse.close();
        }
      } catch (err) {
        console.error('Erro ao processar evento SSE:', err);
      }
    };

    sse.onerror = () => {
      setIsScraping(false);
      sse.close();
      loadJobs();
      loadStats();
    };
  };

  const toggleTerm = (term: string) => {
    if (selectedTerms.includes(term)) {
      if (selectedTerms.length > 1) {
        setSelectedTerms(selectedTerms.filter((t) => t !== term));
      }
    } else {
      setSelectedTerms([...selectedTerms, term]);
    }
  };

  const addCustomTerm = () => {
    const t = newCustomTerm.trim().toLowerCase();
    if (t && !selectedTerms.includes(t)) {
      setSelectedTerms([...selectedTerms, t]);
      // Também adiciona na configuração centralizada
      if (config && !config.searchTerms.includes(t)) {
        const updatedTerms = [...config.searchTerms, t];
        fetch('/api/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ searchTerms: updatedTerms })
        }).then(loadConfig);
      }
      setNewCustomTerm('');
    }
  };

  const toggleSource = (sourceId: string) => {
    if (selectedSources.includes(sourceId)) {
      if (selectedSources.length > 1) {
        setSelectedSources(selectedSources.filter((s) => s !== sourceId));
      }
    } else {
      setSelectedSources([...selectedSources, sourceId]);
    }
  };

  const handleClearDatabase = async () => {
    if (!confirm('Deseja realmente limpar todas as vagas salvas?')) return;
    await fetch('/api/jobs', { method: 'DELETE' });
    setJobs([]);
    setTotalJobs(0);
    loadStats();
  };

  const loadLogStats = async () => {
    try {
      const res = await fetch('/api/logs/stats');
      if (res.ok) {
        setLogStats(await res.json());
      }
    } catch {
      // Ignora silenciosamente
    }
  };

  const loadLogs = async (
    cat = logCategoryFilter,
    query = logSearch
  ) => {
    setIsLoadingLogs(true);
    try {
      const params = new URLSearchParams();
      if (cat === 'ERRORS') {
        params.append('level', 'ERROR');
      } else if (cat !== 'ALL') {
        params.append('category', cat);
      }
      if (query.trim()) params.append('search', query.trim());
      params.append('limit', '150');

      const res = await fetch(`/api/logs?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setLogs(data.logs || []);
        if (data.stats) setLogStats(data.stats);
      }
    } catch (err) {
      console.error('Erro ao carregar logs:', err);
    } finally {
      setIsLoadingLogs(false);
    }
  };

  const handleClearLogs = async () => {
    if (!confirm('Deseja realmente limpar todo o histórico de logs do servidor?')) return;
    try {
      await fetch('/api/logs', { method: 'DELETE' });
      setLogs([]);
      loadLogs(logCategoryFilter, logSearch);
      loadLogStats();
    } catch (err) {
      console.error('Erro ao limpar logs:', err);
    }
  };

  const toggleExpandLog = (id: string) => {
    setExpandedLogIds((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  // Vagas retornadas e filtradas diretamente pelo servidor
  const filteredJobs = jobs;

  return (
    <div>
      {/* Header */}
      <header className="header">
        <div className="brand">
          <div className="brand-icon">
            <Radio size={24} />
          </div>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <h1 className="brand-title">S-Job-Crawler</h1>
              <span className="brand-badge">HIGH-PERFORMANCE</span>
              <span className="brand-badge">ZIMAOS DOCKER EDITION</span>
            </div>
            <p style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
              Agregador inteligente de vagas (Gupy 134 empresas, RemoteOK, Programathor, 99Freelas, GeekHunter)
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          {health && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: '#94a3b8', background: '#1e293b', padding: '0.4rem 0.8rem', borderRadius: '8px' }}>
              <Cpu size={14} color="#10b981" />
              <span>RAM: {health.memoryUsageMB?.rss || 0} MB</span>
            </div>
          )}

          {/* Badge WhatsApp */}
          {waStatus.status === 'connected' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: '#34d399', background: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.3)', padding: '0.4rem 0.8rem', borderRadius: '8px' }}>
              <MessageSquare size={14} color="#10b981" />
              <span>Bot WhatsApp Ativo (+{waStatus.botNumber})</span>
            </div>
          ) : (
            <button
              className="btn-action"
              onClick={() => setShowQrModal(true)}
              style={{ background: '#065f46', borderColor: '#10b981', color: 'white' }}
            >
              <QrCode size={16} /> Conectar WhatsApp
            </button>
          )}

          <button
            className="btn-action"
            onClick={() => {
              setShowLogsModal(true);
              loadLogs();
            }}
            style={{ position: 'relative' }}
            title="Ver auditoria e histórico de logs do sistema"
          >
            <FileText size={16} /> Logs & Auditoria
            {Boolean(logStats?.errors && logStats.errors > 0) && (
              <span
                style={{
                  position: 'absolute',
                  top: '-5px',
                  right: '-5px',
                  background: '#ef4444',
                  color: 'white',
                  fontSize: '0.65rem',
                  fontWeight: 700,
                  borderRadius: '10px',
                  padding: '0.1rem 0.4rem',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.3)'
                }}
              >
                {logStats.errors}
              </span>
            )}
          </button>

          <button className="btn-action" onClick={() => setShowConfigModal(true)}>
            <Settings size={16} /> Configurações
          </button>

          <button className="btn-action danger" onClick={handleClearDatabase} title="Limpar banco de vagas">
            <Trash2 size={16} />
          </button>
        </div>
      </header>

      {/* Card do Bot do WhatsApp & Grupo Alvo */}
      <div className="panel" style={{ background: 'linear-gradient(180deg, #1e293b 0%, #0f172a 100%)', border: '1px solid #334155' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
            <div style={{ background: '#10b981', color: 'white', padding: '0.6rem', borderRadius: '10px' }}>
              <MessageSquare size={22} />
            </div>
            <div>
              <h3 style={{ fontSize: '1rem', fontWeight: 600 }}>Notificações Automáticas no WhatsApp</h3>
              <p style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                {waStatus.status === 'connected'
                  ? `Conectado via Baileys. O bot monitora vagas novas e despacha para o grupo selecionado.`
                  : `Bot offline. Clique em "Conectar WhatsApp" para ler o QR Code pelo seu celular.`}
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: '#94a3b8', background: '#020617', padding: '0.5rem 0.8rem', borderRadius: '8px', border: '1px solid #1e293b' }}>
              <Clock size={14} color="#38bdf8" />
              <span>Scheduler: A cada 30 min</span>
            </div>
          </div>
        </div>

        {waStatus.status === 'connected' && (
          <div style={{ marginTop: '1rem', background: '#0f172a', padding: '1rem', borderRadius: '10px', border: '1px solid #334155' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.8rem', marginBottom: '0.8rem' }}>
              <div>
                <span style={{ fontSize: '0.75rem', color: '#94a3b8', display: 'block' }}>Grupo Ativo para Notificações 24/7:</span>
                <strong style={{ fontSize: '0.9rem', color: waStatus.targetGroupJid ? '#34d399' : '#f59e0b' }}>
                  {waStatus.targetGroupJid ? `🟢 ${waStatus.targetGroupName || waStatus.targetGroupJid}` : '🟡 Nenhum grupo selecionado ainda (selecione abaixo e clique em Salvar)'}
                </strong>
              </div>

              <button
                className="btn-action"
                onClick={() => loadWhatsAppGroups(true)}
                disabled={isLoadingGroups}
                style={{ fontSize: '0.75rem', padding: '0.4rem 0.75rem' }}
                title="Buscar grupos atualizados do WhatsApp"
              >
                <RefreshCw size={13} className={isLoadingGroups ? 'animate-spin' : ''} />
                {isLoadingGroups ? 'Buscando Grupos...' : 'Recarregar Grupos'}
              </button>
            </div>

            {/* Campo de Pesquisa de Grupo em Tempo Real */}
            <div style={{ marginBottom: '0.75rem' }}>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <Search
                  size={15}
                  style={{
                    position: 'absolute',
                    left: '12px',
                    color: '#94a3b8',
                    pointerEvents: 'none'
                  }}
                />
                <input
                  type="text"
                  placeholder="🔎 Pesquisar grupo por nome... (ex: ESTÁGIO, VAGAS, TI)"
                  value={groupSearch}
                  onChange={(e) => setGroupSearch(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.5rem 2.2rem 0.5rem 2.4rem',
                    borderRadius: '8px',
                    background: '#020617',
                    border: '1px solid #334155',
                    color: '#f8fafc',
                    fontSize: '0.85rem'
                  }}
                />
                {groupSearch && (
                  <button
                    type="button"
                    onClick={() => setGroupSearch('')}
                    style={{
                      position: 'absolute',
                      right: '10px',
                      background: 'none',
                      border: 'none',
                      color: '#94a3b8',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      padding: '2px'
                    }}
                    title="Limpar filtro de grupo"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              {groupSearch.trim() && (
                <div
                  style={{
                    marginTop: '0.4rem',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: '0.75rem',
                    color: '#94a3b8'
                  }}
                >
                  <span>
                    Encontrados <strong style={{ color: '#38bdf8' }}>{filteredGroups.length}</strong> de {groups.length} grupos
                  </span>
                  {filteredGroups.length === 0 && (
                    <span style={{ color: '#f87171' }}>Nenhum grupo encontrado com esse nome.</span>
                  )}
                </div>
              )}

              {/* Atalhos rápidos de clique quando houver resultados filtrados (até 8) */}
              {groupSearch.trim() && filteredGroups.length > 0 && filteredGroups.length <= 8 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.45rem' }}>
                  {filteredGroups.map((g) => {
                    const isSelected = selectedGroupJid === g.id;
                    return (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => setSelectedGroupJid(g.id)}
                        style={{
                          fontSize: '0.75rem',
                          padding: '0.35rem 0.65rem',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          background: isSelected ? 'rgba(16, 185, 129, 0.25)' : '#1e293b',
                          color: isSelected ? '#34d399' : '#38bdf8',
                          border: isSelected ? '1px solid #10b981' : '1px solid #334155',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.35rem',
                          transition: 'all 0.15s ease'
                        }}
                      >
                        <span style={{ fontWeight: isSelected ? 600 : 400 }}>{g.subject}</span>
                        <span style={{ fontSize: '0.7rem', opacity: 0.7 }}>({g.participants} membros)</span>
                        {isSelected && <span style={{ fontWeight: 'bold' }}>✓</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
              <select
                className="select-filter"
                value={selectedGroupJid}
                onChange={(e) => setSelectedGroupJid(e.target.value)}
                style={{ minWidth: '260px', flex: 1 }}
              >
                <option value="">
                  {groupSearch.trim()
                    ? `-- ${filteredGroups.length} grupo(s) filtrado(s) --`
                    : `-- Selecione o grupo que receberá as vagas (${groups.length} disponíveis) --`}
                </option>
                {waStatus.targetGroupJid &&
                  !filteredGroups.some((g) => g.id === waStatus.targetGroupJid) && (
                    <option value={waStatus.targetGroupJid}>
                      {waStatus.targetGroupName || 'Grupo Atual'} (Salvo no Servidor)
                    </option>
                  )}
                {selectedGroupJid &&
                  selectedGroupJid !== waStatus.targetGroupJid &&
                  !filteredGroups.some((g) => g.id === selectedGroupJid) && (
                    <option value={selectedGroupJid}>
                      {groups.find((g) => g.id === selectedGroupJid)?.subject || 'Grupo Selecionado'}
                    </option>
                  )}
                {filteredGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.subject} ({g.participants} membros)
                  </option>
                ))}
              </select>

              <button
                className="btn-action primary"
                onClick={handleSaveGroup}
                disabled={isSavingGroup || !selectedGroupJid || selectedGroupJid === waStatus.targetGroupJid}
                style={{ whiteSpace: 'nowrap' }}
              >
                <Save size={14} />
                {isSavingGroup ? 'Salvando...' : selectedGroupJid && selectedGroupJid === waStatus.targetGroupJid ? 'Salvo ✓' : 'Salvar Grupo'}
              </button>

              <button
                className="btn-action"
                onClick={handleTestWhatsApp}
                disabled={testSending || !waStatus.targetGroupJid}
                style={{ whiteSpace: 'nowrap' }}
              >
                <Send size={14} /> {testSending ? 'Enviando...' : 'Testar Envio'}
              </button>
            </div>

            {selectedGroupJid && selectedGroupJid !== waStatus.targetGroupJid && (
              <div style={{ marginTop: '0.6rem', fontSize: '0.8rem', color: '#fbbf24', display: 'flex', alignItems: 'center', gap: '0.4rem', background: 'rgba(245, 158, 11, 0.1)', padding: '0.4rem 0.75rem', borderRadius: '6px', border: '1px solid rgba(245, 158, 11, 0.25)' }}>
                <span>⚠️ Selecionado:</span>
                <strong style={{ color: '#f8fafc' }}>
                  {groups.find((g) => g.id === selectedGroupJid)?.subject || selectedGroupJid}
                </strong>
                <span style={{ color: '#94a3b8' }}>— clique em "Salvar Grupo" para confirmar.</span>
              </div>
            )}

            {groupSaveMsg && (
              <div style={{ marginTop: '0.8rem', padding: '0.5rem 0.8rem', borderRadius: '6px', background: 'rgba(16, 185, 129, 0.15)', border: '1px solid #10b981', fontSize: '0.8rem', color: '#6ee7b7' }}>
                {groupSaveMsg}
              </div>
            )}

            {testResultMsg && (
              <div style={{ marginTop: '0.8rem', padding: '0.5rem 0.8rem', borderRadius: '6px', background: 'rgba(59, 130, 246, 0.15)', border: '1px solid #3b82f6', fontSize: '0.8rem', color: '#93c5fd' }}>
                {testResultMsg}
              </div>
            )}

            {/* Fila de Envio e Cadência Anti-Ban */}
            {Boolean(waStatus.queuePendingCount && waStatus.queuePendingCount > 0) && (
              <div style={{ marginTop: '1rem', background: 'rgba(59, 130, 246, 0.1)', border: '1px solid rgba(59, 130, 246, 0.3)', borderRadius: '8px', padding: '0.8rem 1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.6rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <Send size={18} color="#60a5fa" className={waStatus.isProcessingQueue ? 'animate-bounce' : ''} />
                  <div>
                    <strong style={{ fontSize: '0.85rem', color: '#93c5fd', display: 'block' }}>
                      Fila de Envio Ativa: {waStatus.queuePendingCount} vaga(s) aguardando envio
                    </strong>
                    <span style={{ fontSize: '0.78rem', color: '#94a3b8' }}>
                      {waStatus.isProcessingQueue
                        ? '🚀 Despachando lote atual (3 mensagens completas espaçadas por 5s)...'
                        : waStatus.nextBatchRemainingSeconds && waStatus.nextBatchRemainingSeconds > 0
                          ? `⏳ Intervalo anti-ban: Próximo lote de 3 vagas em ${Math.floor(waStatus.nextBatchRemainingSeconds / 60)}m ${waStatus.nextBatchRemainingSeconds % 60}s`
                          : 'Aguardando liberação do próximo lote...'}
                    </span>
                  </div>
                </div>
                <div style={{ fontSize: '0.75rem', background: '#1e293b', padding: '0.3rem 0.6rem', borderRadius: '6px', color: '#38bdf8', border: '1px solid #334155' }}>
                  Lotes de 3 vagas a cada 5 min
                </div>
              </div>
            )}

            {/* Disparo Manual de Mensagens por Categoria */}
            <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #334155' }}>
              <div style={{ marginBottom: '0.6rem' }}>
                <h4 style={{ fontSize: '0.9rem', fontWeight: 600, color: '#f8fafc', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  <Send size={15} color="#10b981" /> Disparo de Vagas por Categoria
                </h4>
                <p style={{ fontSize: '0.78rem', color: '#94a3b8' }}>
                  Selecione a categoria de vagas e dispare para o WhatsApp. O bot enviará vagas completas em lotes de 3 a cada 5 minutos até esgotar a fila:
                </p>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                <select
                  className="select-filter"
                  value={dispatchCategory}
                  onChange={(e) => {
                    const cat = e.target.value;
                    setDispatchCategory(cat);
                    loadPendingCount(cat);
                  }}
                  style={{ minWidth: '220px' }}
                >
                  <option value="ESTAGIO">Estágio ({dispatchCategory === 'ESTAGIO' ? pendingCategoryCount : '...'} pendentes)</option>
                  <option value="JUNIOR">Júnior ({dispatchCategory === 'JUNIOR' ? pendingCategoryCount : '...'} pendentes)</option>
                  <option value="PLENO">Pleno ({dispatchCategory === 'PLENO' ? pendingCategoryCount : '...'} pendentes)</option>
                  <option value="SENIOR">Sênior ({dispatchCategory === 'SENIOR' ? pendingCategoryCount : '...'} pendentes)</option>
                  <option value="FREELANCER">Freelancer / PJ ({dispatchCategory === 'FREELANCER' ? pendingCategoryCount : '...'} pendentes)</option>
                  <option value="TODAS">Todas as Categorias ({dispatchCategory === 'TODAS' ? pendingCategoryCount : '...'} pendentes)</option>
                </select>

                <button
                  className="btn-action primary"
                  onClick={handleDispatchCategory}
                  disabled={isDispatching || pendingCategoryCount === 0 || !waStatus.targetGroupJid}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  <Send size={14} />
                  {isDispatching ? 'Enfileirando...' : `Disparar Vagas da Categoria (${pendingCategoryCount})`}
                </button>
              </div>

              {dispatchResultMsg && (
                <div style={{ marginTop: '0.6rem', padding: '0.5rem 0.8rem', borderRadius: '6px', background: 'rgba(16, 185, 129, 0.15)', border: '1px solid #10b981', fontSize: '0.8rem', color: '#6ee7b7' }}>
                  {dispatchResultMsg}
                </div>
              )}
            </div>

            {/* Categorias Selecionadas para Envio Automático */}
            <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid #334155' }}>
              <div style={{ marginBottom: '0.5rem' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: 600, color: '#f8fafc' }}>
                  🤖 Categorias do Envio Automático (Scheduler 24/7):
                </span>
                <p style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                  Clique para marcar quais categorias serão despachadas automaticamente para o grupo quando o crawler encontrar novas oportunidades:
                </p>
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
                {[
                  { id: 'ESTAGIO', label: 'Estágio' },
                  { id: 'JUNIOR', label: 'Júnior' },
                  { id: 'PLENO', label: 'Pleno' },
                  { id: 'SENIOR', label: 'Sênior' },
                  { id: 'FREELANCER', label: 'Freelancer / PJ' },
                  { id: 'TODAS', label: 'Todas' }
                ].map((cat) => {
                  const isActive = (waStatus.targetCategories || ['TODAS']).includes(cat.id);
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      className={`tag-badge ${isActive ? 'active' : ''}`}
                      onClick={() => handleToggleTargetCategory(cat.id)}
                      disabled={isSavingCategories}
                      style={{ cursor: 'pointer', border: '1px solid transparent' }}
                    >
                      {cat.label} {isActive ? '✓' : '+'}
                    </button>
                  );
                })}
                {categorySaveMsg && (
                  <span style={{ fontSize: '0.75rem', color: '#34d399', marginLeft: '0.5rem' }}>
                    ✓ {categorySaveMsg}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Estatísticas Rápidas */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon" style={{ color: '#3b82f6' }}><Briefcase size={20} /></div>
          <div>
            <div className="stat-value">{totalJobs}</div>
            <div className="stat-label">Vagas no Banco</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon" style={{ color: '#10b981' }}><CheckCircle2 size={20} /></div>
          <div>
            <div className="stat-value">{stats.byModel?.REMOTO || 0}</div>
            <div className="stat-label">Vagas Remotas</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon" style={{ color: '#8b5cf6' }}><Layers size={20} /></div>
          <div>
            <div className="stat-value">{stats.bySource?.GUPY || 0}</div>
            <div className="stat-label">Vagas Gupy</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon" style={{ color: '#f59e0b' }}><Activity size={20} /></div>
          <div>
            <div className="stat-value">{stats.bySource?.FREELAS_99 || stats.bySource?.REMOTEOK || 0}</div>
            <div className="stat-value">{(stats.bySource?.FREELAS_99 || 0) + (stats.bySource?.REMOTEOK || 0)}</div>
            <div className="stat-label">Freelance / Global</div>
          </div>
        </div>
      </div>
      {/* Painel de Controle de Varredura */}
      <div className="panel">
        <div className="panel-title">
          <span>🎯 Painel de Varredura Unificada</span>
          <button
            className="btn-action primary"
            onClick={startScrape}
            disabled={isScraping}
            style={{ opacity: isScraping ? 0.7 : 1 }}
          >
            {isScraping ? <RefreshCw size={16} className="animate-spin" /> : <Play size={16} />}
            {isScraping ? 'Varrendo em Tempo Real...' : 'Iniciar Varredura'}
          </button>
        </div>

        <div className="search-form">
          <div>
            <label style={{ fontSize: '0.8rem', color: '#94a3b8', display: 'block', marginBottom: '0.4rem' }}>
              Selecione as Stacks / Palavras-chave da busca:
            </label>
            <div className="tags-container">
              {(config?.searchTerms || ['java', 'react', 'node', 'fullstack', 'python']).map((term) => (
                <div
                  key={term}
                  className={`tag-badge ${selectedTerms.includes(term) ? 'active' : ''}`}
                  onClick={() => toggleTerm(term)}
                >
                  {term}
                  {selectedTerms.includes(term) && ' ✓'}
                </div>
              ))}
              <div style={{ display: 'flex', gap: '0.3rem' }}>
                <input
                  type="text"
                  placeholder="+ Novo termo"
                  value={newCustomTerm}
                  onChange={(e) => setNewCustomTerm(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addCustomTerm()}
                  style={{ background: '#0f172a', border: '1px solid #334155', borderRadius: '6px', color: 'white', padding: '0.2rem 0.5rem', fontSize: '0.8rem', width: '110px' }}
                />
              </div>
            </div>
          </div>

          <div>
            <label style={{ fontSize: '0.8rem', color: '#94a3b8', display: 'block', marginBottom: '0.4rem' }}>
              Plataformas e Fontes Ativas:
            </label>
            <div className="sources-grid">
              {[
                { id: 'GUPY', label: `Gupy (${config?.gupyCompanies?.length || 134})`, type: 'CLT' },
                { id: 'INHIRE', label: `InHire (${config?.inhireCompanies?.length || 63})`, type: 'CLT' },
                { id: 'ASHBY', label: `Ashby (${config?.ashbyCompanies?.length || 41})`, type: 'CLT' },
                { id: 'LEVER', label: `Lever (${config?.leverCompanies?.length || 25})`, type: 'CLT' },
                { id: 'GREENHOUSE', label: `Greenhouse (${config?.greenhouseCompanies?.length || 7})`, type: 'CLT' },
                { id: 'WORKABLE', label: `Workable (${config?.workableCompanies?.length || 22})`, type: 'CLT' },
                { id: 'REMOTEOK', label: 'RemoteOK (Global)', type: 'FREELANCE' },
                { id: 'PROGRAMATHOR', label: 'Programathor', type: 'CLT' },
                { id: 'FREELAS_99', label: '99Freelas', type: 'FREELANCE' },
                { id: 'GEEKHUNTER', label: 'GeekHunter', type: 'CLT' }
              ].map((s) => (
                <div
                  key={s.id}
                  className={`source-checkbox ${selectedSources.includes(s.id) ? 'checked' : ''}`}
                  onClick={() => toggleSource(s.id)}
                >
                  <input
                    type="checkbox"
                    checked={selectedSources.includes(s.id)}
                    onChange={() => { }}
                    style={{ cursor: 'pointer' }}
                  />
                  <span>{s.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Monitor de Execução Streaming SSE */}
      {isScraping && (
        <div className="stream-box">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
            <span style={{ color: '#38bdf8' }}>⚡ {scrapeProgress.message}</span>
            <span style={{ color: '#10b981' }}>{scrapeProgress.totalFound} vagas capturadas</span>
          </div>
          {scrapeProgress.currentCompany && (
            <div style={{ color: '#94a3b8', fontSize: '0.78rem', marginBottom: '0.3rem' }}>
              Empresa atual: <strong style={{ color: '#f8fafc' }}>{scrapeProgress.currentCompany}</strong>
            </div>
          )}
          <div className="progress-bar-container">
            <div className="progress-bar-fill" style={{ width: `${scrapeProgress.percent || 15}%` }} />
          </div>
        </div>
      )}

      {/* Barra de Filtros dos Resultados */}
      <div className="filters-bar">
        <div style={{ position: 'relative', flex: 1, minWidth: '260px' }}>
          <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
          <input
            type="text"
            className="search-input"
            placeholder="Filtrar vagas por título, empresa ou tecnologia..."
            value={searchFilter}
            onChange={(e) => {
              setSearchFilter(e.target.value);
              setCurrentPage(1);
            }}
            style={{ paddingLeft: '36px' }}
          />
        </div>

        <select
          className="select-filter"
          value={modelFilter}
          onChange={(e) => {
            setModelFilter(e.target.value);
            setCurrentPage(1);
          }}
        >
          <option value="ALL">Todos os Modelos</option>
          <option value="REMOTO">Remoto</option>
          <option value="HIBRIDO">Híbrido</option>
          <option value="PRESENCIAL">Presencial</option>
        </select>

        <select
          className="select-filter"
          value={contractFilter}
          onChange={(e) => {
            setContractFilter(e.target.value);
            setCurrentPage(1);
          }}
        >
          <option value="ALL">Contrato (Todos)</option>
          <option value="CLT">CLT</option>
          <option value="PJ">PJ</option>
          <option value="FREELANCER">Freelancer / Projeto</option>
        </select>

        <select
          className="select-filter"
          value={sourceFilter}
          onChange={(e) => {
            setSourceFilter(e.target.value);
            setCurrentPage(1);
          }}
        >
          <option value="ALL">Todas as Fontes</option>
          <option value="GUPY">Gupy</option>
          <option value="INHIRE">InHire</option>
          <option value="ASHBY">Ashby</option>
          <option value="LEVER">Lever</option>
          <option value="GREENHOUSE">Greenhouse</option>
          <option value="WORKABLE">Workable</option>
          <option value="REMOTEOK">RemoteOK</option>
          <option value="PROGRAMATHOR">Programathor</option>
          <option value="FREELAS_99">99Freelas</option>
          <option value="GEEKHUNTER">GeekHunter</option>
        </select>

        <select
          className="select-filter"
          value={notifiedFilter}
          onChange={(e) => {
            setNotifiedFilter(e.target.value as any);
            setCurrentPage(1);
          }}
          style={{
            borderColor: notifiedFilter !== 'ALL' ? '#3b82f6' : undefined,
            color: notifiedFilter === 'PENDING' ? '#fbbf24' : notifiedFilter === 'NOTIFIED' ? '#34d399' : 'white'
          }}
        >
          <option value="ALL">WhatsApp (Todos)</option>
          <option value="PENDING">⚪ Apenas Pendentes</option>
          <option value="NOTIFIED">🟢 Apenas Enviadas</option>
        </select>

        {/* Toggle Somente TI */}
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.45rem',
            fontSize: '0.82rem',
            color: onlyTechFilter ? '#34d399' : '#94a3b8',
            cursor: 'pointer',
            background: onlyTechFilter ? 'rgba(16, 185, 129, 0.12)' : 'rgba(255, 255, 255, 0.04)',
            border: `1px solid ${onlyTechFilter ? 'rgba(16, 185, 129, 0.35)' : 'rgba(255, 255, 255, 0.1)'}`,
            borderRadius: '8px',
            padding: '0.45rem 0.75rem',
            userSelect: 'none'
          }}
          title="Exibe somente vagas validadas como Tecnologia/TI"
        >
          <input
            type="checkbox"
            checked={onlyTechFilter}
            onChange={(e) => {
              setOnlyTechFilter(e.target.checked);
              setCurrentPage(1);
            }}
            style={{ accentColor: '#10b981', cursor: 'pointer' }}
          />
          Somente TI
        </label>

        {/* Botão de Expurgo de Não-TI */}
        <button
          type="button"
          onClick={handlePurgeNonTech}
          disabled={isPurging}
          className="btn-action"
          style={{
            padding: '0.45rem 0.85rem',
            fontSize: '0.82rem',
            background: 'rgba(239, 68, 68, 0.12)',
            borderColor: 'rgba(239, 68, 68, 0.35)',
            color: '#fca5a5',
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            cursor: isPurging ? 'not-allowed' : 'pointer'
          }}
          title="Executa expurgo e backup de vagas fora de Tecnologia"
        >
          {isPurging ? <RefreshCw size={14} className="spin" /> : <Trash2 size={14} />}
          {isPurging ? 'Limpando...' : 'Expurgar Não-TI'}
        </button>
      </div>

      {purgeResultMsg && (
        <div
          style={{
            margin: '0.75rem 0',
            padding: '0.75rem 1rem',
            borderRadius: '8px',
            background: 'rgba(16, 185, 129, 0.12)',
            border: '1px solid rgba(16, 185, 129, 0.35)',
            color: '#34d399',
            fontSize: '0.88rem',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}
        >
          <span>{purgeResultMsg}</span>
          <button
            type="button"
            onClick={() => setPurgeResultMsg(null)}
            style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer' }}
          >
            <X size={16} />
          </button>
        </div>
      )}

      {/* Grid de Vagas */}
      {filteredJobs.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '3rem', background: '#1e293b', borderRadius: '12px', border: '1px dashed #334155' }}>
          <Briefcase size={36} color="#64748b" style={{ margin: '0 auto 0.8rem' }} />
          <p style={{ color: '#94a3b8', fontSize: '1rem', fontWeight: 500 }}>Nenhuma vaga encontrada para os filtros atuais.</p>
          <p style={{ color: '#64748b', fontSize: '0.85rem', marginTop: '0.3rem' }}>
            Clique em "Iniciar Varredura" para coletar oportunidades em tempo real!
          </p>
        </div>
      ) : (
        <div className="jobs-grid">
          {filteredJobs.map((job) => (
            <div key={job.id} className="job-card">
              <div>
                <div className="job-header">
                  <h3 className="job-title">{job.title}</h3>
                  <span className={`source-badge ${job.source.toLowerCase()}`}>{job.source}</span>
                </div>

                <div className="job-company">
                  <Building size={13} style={{ display: 'inline', marginRight: '4px', verticalAlign: '-1px' }} />
                  {job.company}
                </div>

                <div className="job-badges">
                  {job.workModel === 'REMOTO' && <span className="badge remote">Remoto</span>}
                  {job.workModel === 'HIBRIDO' && <span className="badge hybrid">Híbrido</span>}
                  {job.workModel === 'PRESENCIAL' && <span className="badge onsite">Presencial</span>}

                  {job.seniorityLevel !== 'NAO_INFORMADO' && (
                    <span className="badge seniority">{job.seniorityLevel}</span>
                  )}

                  <span className="badge clt">{job.contractType}</span>

                  <span style={{ fontSize: '0.72rem', color: '#64748b', display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                    <MapPin size={11} /> {job.location}
                  </span>

                  {/* Badge de status do WhatsApp */}
                  {job.notifiedAt ? (
                    <span
                      className="badge"
                      style={{
                        background: 'rgba(16, 185, 129, 0.15)',
                        color: '#34d399',
                        border: '1px solid rgba(16, 185, 129, 0.35)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px'
                      }}
                      title={`Enviada ao WhatsApp em ${new Date(job.notifiedAt).toLocaleString('pt-BR')}`}
                    >
                      <CheckCircle2 size={11} color="#10b981" /> Enviada
                    </span>
                  ) : (
                    <span
                      className="badge"
                      style={{
                        background: 'rgba(148, 163, 184, 0.1)',
                        color: '#94a3b8',
                        border: '1px solid rgba(148, 163, 184, 0.25)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px'
                      }}
                      title="Vaga pendente de envio ao WhatsApp"
                    >
                      <Clock size={11} color="#94a3b8" /> Pendente
                    </span>
                  )}
                </div>

                {job.stack && job.stack.length > 0 && (
                  <div className="job-stack">
                    {job.stack.slice(0, 6).map((tech) => (
                      <span key={tech} className="stack-pill">{tech}</span>
                    ))}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.8rem', alignItems: 'stretch' }}>
                <button
                  type="button"
                  onClick={() => handleToggleJobNotified(job.id, !!job.notifiedAt)}
                  className="btn-action"
                  style={{
                    flex: '0 0 auto',
                    padding: '0.5rem 0.75rem',
                    fontSize: '0.78rem',
                    background: job.notifiedAt ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.12)',
                    borderColor: job.notifiedAt ? 'rgba(239, 68, 68, 0.35)' : 'rgba(16, 185, 129, 0.35)',
                    color: job.notifiedAt ? '#fca5a5' : '#6ee7b7',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    cursor: 'pointer'
                  }}
                  title={job.notifiedAt ? 'Clique para desmarcar e tornar a vaga pendente' : 'Clique para marcar a vaga como enviada ao WhatsApp'}
                >
                  {job.notifiedAt ? (
                    <>
                      <X size={13} /> Desmarcar
                    </>
                  ) : (
                    <>
                      <CheckCircle2 size={13} /> Marcar Enviada
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => handleMarkNotTech(job)}
                  className="btn-action"
                  style={{
                    flex: '0 0 auto',
                    padding: '0.5rem 0.65rem',
                    fontSize: '0.78rem',
                    background: 'rgba(239, 68, 68, 0.1)',
                    borderColor: 'rgba(239, 68, 68, 0.3)',
                    color: '#f87171',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    cursor: 'pointer'
                  }}
                  title="Marcar como Não-TI (Remove da lista e ensina o classificador)"
                >
                  <Trash2 size={13} /> Não-TI
                </button>

                <a
                  href={job.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-apply"
                  style={{ flex: 1 }}
                >
                  Ver Vaga <ExternalLink size={14} />
                </a>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Barra de Paginação */}
      {totalJobs > 0 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '1rem', marginTop: '2rem', marginBottom: '2rem' }}>
          <button
            className="btn-action secondary"
            disabled={currentPage <= 1}
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            style={{
              padding: '0.5rem 1.2rem',
              borderRadius: '8px',
              opacity: currentPage <= 1 ? 0.4 : 1,
              cursor: currentPage <= 1 ? 'not-allowed' : 'pointer'
            }}
          >
            ◀ Anterior
          </button>
          <span style={{ fontSize: '0.9rem', color: '#94a3b8' }}>
            Página <strong style={{ color: '#f8fafc' }}>{currentPage}</strong> de{' '}
            <strong style={{ color: '#f8fafc' }}>{Math.max(1, Math.ceil(totalJobs / pageSize))}</strong>{' '}
            <span style={{ color: '#64748b' }}>({totalJobs} vagas encontradas)</span>
          </span>
          <button
            className="btn-action secondary"
            disabled={currentPage >= Math.ceil(totalJobs / pageSize)}
            onClick={() => setCurrentPage((p) => p + 1)}
            style={{
              padding: '0.5rem 1.2rem',
              borderRadius: '8px',
              opacity: currentPage >= Math.ceil(totalJobs / pageSize) ? 0.4 : 1,
              cursor: currentPage >= Math.ceil(totalJobs / pageSize) ? 'not-allowed' : 'pointer'
            }}
          >
            Próxima ▶
          </button>

          <select
            className="select-filter"
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setCurrentPage(1);
            }}
            style={{ padding: '0.45rem 0.6rem', fontSize: '0.85rem' }}
          >
            <option value={25}>25 por página</option>
            <option value={50}>50 por página</option>
            <option value={100}>100 por página</option>
          </select>
        </div>
      )}

      {/* Modal de Configuração */}
      {/* Modal Conectar WhatsApp com QR Code */}
      {showQrModal && (
        <div className="modal-overlay" onClick={() => setShowQrModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '440px', textAlign: 'center' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h2 style={{ fontSize: '1.2rem', fontWeight: 600 }}>📲 Conectar WhatsApp</h2>
              <button onClick={() => setShowQrModal(false)} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}>
                <X size={20} />
              </button>
            </div>

            {waStatus.status === 'connected' ? (
              <div style={{ padding: '2rem 1rem' }}>
                <CheckCircle2 size={48} color="#10b981" style={{ margin: '0 auto 1rem' }} />
                <h3 style={{ color: '#34d399', marginBottom: '0.5rem' }}>WhatsApp Conectado!</h3>
                <p style={{ fontSize: '0.9rem', color: '#94a3b8' }}>
                  O bot está ativo no número <strong>+{waStatus.botNumber}</strong>.
                </p>
                <button className="btn-action primary" onClick={() => setShowQrModal(false)} style={{ marginTop: '1.5rem', width: '100%' }}>
                  Concluir
                </button>
              </div>
            ) : waStatus.qrCode ? (
              <div>
                <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginBottom: '1rem' }}>
                  Abra o WhatsApp no celular &gt; <strong>Aparelhos conectados</strong> &gt; <strong>Conectar aparelho</strong> e aponte a câmera:
                </p>
                <div style={{ background: 'white', padding: '1rem', borderRadius: '12px', display: 'inline-block', marginBottom: '1rem' }}>
                  <img src={waStatus.qrCode} alt="WhatsApp QR Code" style={{ width: '240px', height: '240px', display: 'block' }} />
                </div>
                <p style={{ fontSize: '0.78rem', color: '#64748b' }}>
                  O código expira em 40 segundos e atualiza automaticamente.
                </p>
              </div>
            ) : (
              <div style={{ padding: '2rem 1rem' }}>
                <RefreshCw size={32} className="animate-spin" color="#3b82f6" style={{ margin: '0 auto 1rem' }} />
                <p style={{ fontSize: '0.9rem', color: '#94a3b8' }}>
                  Gerando QR Code de conexão... aguarde um instante.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal de Configuração Geral / Empresas Monitoradas */}
      {showConfigModal && config && (
        <div className="modal-overlay" onClick={() => setShowConfigModal(false)}>
          <div className="modal-content" style={{ maxWidth: '750px' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <Building size={22} color="#3b82f6" />
                <h2 style={{ fontSize: '1.2rem', fontWeight: 600 }}>Empresas & Plataformas Monitoradas</h2>
              </div>
              <button onClick={() => setShowConfigModal(false)} style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer' }}>
                <X size={20} />
              </button>
            </div>

            <p style={{ fontSize: '0.85rem', color: '#94a3b8', marginBottom: '1rem' }}>
              Arquivo de configuração ativo: <code style={{ color: '#38bdf8' }}>config/search.config.json</code>
            </p>

            {/* ATS Tabs */}
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
              {[
                { id: 'GUPY', label: 'Gupy', count: config.gupyCompanies?.length || 0, color: '#3b82f6' },
                { id: 'INHIRE', label: 'InHire', count: config.inhireCompanies?.length || 0, color: '#06b6d4' },
                { id: 'ASHBY', label: 'Ashby', count: config.ashbyCompanies?.length || 0, color: '#8b5cf6' },
                { id: 'LEVER', label: 'Lever', count: config.leverCompanies?.length || 0, color: '#10b981' },
                { id: 'GREENHOUSE', label: 'Greenhouse', count: config.greenhouseCompanies?.length || 0, color: '#f59e0b' },
                { id: 'WORKABLE', label: 'Workable', count: config.workableCompanies?.length || 0, color: '#ec4899' },
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setConfigModalTab(tab.id as any)}
                  style={{
                    padding: '0.4rem 0.8rem',
                    borderRadius: '8px',
                    fontSize: '0.82rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    border: configModalTab === tab.id ? `1px solid ${tab.color}` : '1px solid #334155',
                    background: configModalTab === tab.id ? `${tab.color}22` : '#1e293b',
                    color: configModalTab === tab.id ? '#f8fafc' : '#94a3b8',
                    transition: 'all 0.2s ease',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.4rem'
                  }}
                >
                  <span>{tab.label}</span>
                  <span style={{
                    background: configModalTab === tab.id ? tab.color : '#334155',
                    color: '#fff',
                    borderRadius: '12px',
                    padding: '0.1rem 0.45rem',
                    fontSize: '0.72rem'
                  }}>
                    {tab.count}
                  </span>
                </button>
              ))}
            </div>

            {/* Quick search input */}
            <div style={{ position: 'relative', marginBottom: '0.75rem' }}>
              <Search size={16} color="#64748b" style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)' }} />
              <input
                type="text"
                placeholder={`Buscar empresa em ${configModalTab}...`}
                value={configSearchTerm}
                onChange={(e) => setConfigSearchTerm(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.5rem 0.75rem 0.5rem 2.2rem',
                  borderRadius: '6px',
                  background: '#0f172a',
                  border: '1px solid #334155',
                  color: '#f8fafc',
                  fontSize: '0.85rem'
                }}
              />
            </div>

            {/* Company List */}
            {(() => {
              const currentList =
                configModalTab === 'GUPY' ? config.gupyCompanies :
                  configModalTab === 'INHIRE' ? config.inhireCompanies :
                    configModalTab === 'ASHBY' ? config.ashbyCompanies :
                      configModalTab === 'LEVER' ? config.leverCompanies :
                        configModalTab === 'GREENHOUSE' ? config.greenhouseCompanies :
                          config.workableCompanies;

              const filtered = (currentList || []).filter(c =>
                c.name.toLowerCase().includes(configSearchTerm.toLowerCase()) ||
                c.slug.toLowerCase().includes(configSearchTerm.toLowerCase())
              );

              return (
                <div style={{ marginBottom: '1.5rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <span style={{ fontSize: '0.85rem', color: '#94a3b8' }}>
                      Exibindo {filtered.length} de {currentList?.length || 0} empresas
                    </span>
                  </div>
                  <div style={{
                    maxHeight: '320px',
                    overflowY: 'auto',
                    background: '#0f172a',
                    padding: '0.5rem',
                    borderRadius: '8px',
                    border: '1px solid #334155',
                    fontSize: '0.82rem'
                  }}>
                    {filtered.length === 0 ? (
                      <p style={{ color: '#64748b', textAlign: 'center', padding: '1rem' }}>
                        Nenhuma empresa encontrada com o termo "{configSearchTerm}".
                      </p>
                    ) : (
                      filtered.map((c, i) => (
                        <div
                          key={i}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '0.45rem 0.5rem',
                            borderBottom: i < filtered.length - 1 ? '1px solid #1e293b' : 'none',
                          }}
                        >
                          <div>
                            <span style={{ fontWeight: 500, color: '#f1f5f9' }}>{c.name}</span>
                            <span style={{ color: '#64748b', marginLeft: '0.6rem', fontSize: '0.75rem' }}>
                              ({c.slug})
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span style={{
                              fontSize: '0.7rem',
                              padding: '0.15rem 0.4rem',
                              borderRadius: '4px',
                              background: '#10b98122',
                              color: '#34d399',
                              border: '1px solid #10b98144'
                            }}>
                              Ativa
                            </span>
                            {c.link && (
                              <a
                                href={c.link}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Abrir página de carreiras"
                                style={{ color: '#60a5fa', display: 'flex', alignItems: 'center' }}
                              >
                                <ExternalLink size={14} />
                              </a>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            })()}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
                Total integrado: {(config.gupyCompanies?.length || 0) + (config.inhireCompanies?.length || 0) + (config.ashbyCompanies?.length || 0) + (config.leverCompanies?.length || 0) + (config.greenhouseCompanies?.length || 0) + (config.workableCompanies?.length || 0)} empresas
              </span>
              <button className="btn-action primary" onClick={() => setShowConfigModal(false)}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal de Auditoria e Logs do Sistema */}
      {showLogsModal && (
        <div className="modal-overlay" onClick={() => setShowLogsModal(false)}>
          <div
            className="modal-content"
            style={{ maxWidth: '900px', width: '95%', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Top Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.6rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <FileText size={22} color="#3b82f6" />
                <h2 style={{ fontSize: '1.2rem', fontWeight: 600 }}>Auditoria & Telemetria do Sistema</h2>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                {Boolean(logStats?.errors && logStats.errors > 0) && (
                  <span style={{ fontSize: '0.75rem', padding: '0.2rem 0.6rem', borderRadius: '6px', background: 'rgba(239, 68, 68, 0.15)', color: '#f87171', border: '1px solid rgba(239, 68, 68, 0.35)', fontWeight: 600 }}>
                    {logStats.errors} erro(s)
                  </span>
                )}
                {Boolean(logStats?.total) && (
                  <span style={{ fontSize: '0.75rem', padding: '0.2rem 0.6rem', borderRadius: '6px', background: '#1e293b', color: '#94a3b8', border: '1px solid #334155' }}>
                    {logStats.total} eventos no buffer
                  </span>
                )}

                <a
                  href="/api/logs/export"
                  download="s-job-crawler-logs.json"
                  className="btn-action"
                  style={{ fontSize: '0.75rem', padding: '0.4rem 0.65rem', textDecoration: 'none', color: '#f8fafc' }}
                  title="Baixar todos os logs em formato JSON"
                >
                  <Download size={13} /> Exportar
                </a>

                <button
                  className="btn-action"
                  onClick={() => loadLogs(logCategoryFilter, logSearch)}
                  disabled={isLoadingLogs}
                  style={{ fontSize: '0.75rem', padding: '0.4rem 0.65rem' }}
                  title="Recarregar logs"
                >
                  <RefreshCw size={13} className={isLoadingLogs ? 'animate-spin' : ''} /> {isLoadingLogs ? 'Carregando...' : 'Recarregar'}
                </button>

                <button
                  className="btn-action danger"
                  onClick={handleClearLogs}
                  style={{ fontSize: '0.75rem', padding: '0.4rem 0.65rem' }}
                  title="Limpar logs"
                >
                  <Trash2 size={13} />
                </button>

                <button
                  onClick={() => setShowLogsModal(false)}
                  style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                >
                  <X size={20} />
                </button>
              </div>
            </div>

            {/* Category Filter Tabs */}
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.8rem' }}>
              {[
                { id: 'ALL', label: 'Todos', color: '#3b82f6' },
                { id: 'CLASSIFIER', label: '🤖 Filtros TI', color: '#10b981' },
                { id: 'WHATSAPP', label: '📲 WhatsApp', color: '#38bdf8' },
                { id: 'CRAWLER', label: '⚡ Crawler', color: '#8b5cf6' },
                { id: 'USER_ACTION', label: '👤 Ações Humanas', color: '#f59e0b' },
                { id: 'ERRORS', label: '⚠️ Apenas Erros', color: '#ef4444' },
              ].map((tab) => {
                const isActive = logCategoryFilter === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => {
                      setLogCategoryFilter(tab.id as any);
                      loadLogs(tab.id as any, logSearch);
                    }}
                    style={{
                      padding: '0.35rem 0.75rem',
                      borderRadius: '8px',
                      fontSize: '0.8rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                      border: isActive ? `1px solid ${tab.color}` : '1px solid #334155',
                      background: isActive ? `${tab.color}22` : '#1e293b',
                      color: isActive ? '#f8fafc' : '#94a3b8',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {/* Search filter input */}
            <div style={{ position: 'relative', marginBottom: '0.8rem' }}>
              <Search size={15} color="#64748b" style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)' }} />
              <input
                type="text"
                placeholder="Buscar em logs (vaga, erro, empresa, termo)..."
                value={logSearch}
                onChange={(e) => {
                  const val = e.target.value;
                  setLogSearch(val);
                  loadLogs(logCategoryFilter, val);
                }}
                style={{
                  width: '100%',
                  padding: '0.45rem 2rem 0.45rem 2.2rem',
                  borderRadius: '6px',
                  background: '#0f172a',
                  border: '1px solid #334155',
                  color: '#f8fafc',
                  fontSize: '0.85rem'
                }}
              />
              {logSearch && (
                <button
                  type="button"
                  onClick={() => {
                    setLogSearch('');
                    loadLogs(logCategoryFilter, '');
                  }}
                  style={{
                    position: 'absolute',
                    right: '10px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    color: '#94a3b8',
                    cursor: 'pointer'
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {/* Logs List Container */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                background: '#020617',
                padding: '0.6rem',
                borderRadius: '8px',
                border: '1px solid #1e293b',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
                minHeight: '280px',
                maxHeight: '480px'
              }}
            >
              {logs.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem 1rem', color: '#64748b' }}>
                  <FileText size={32} style={{ margin: '0 auto 0.6rem', opacity: 0.5 }} />
                  <p style={{ fontSize: '0.9rem' }}>Nenhum log registrado para os filtros atuais.</p>
                </div>
              ) : (
                logs.map((item) => {
                  const isExpanded = expandedLogIds[item.id];
                  const isError = item.level === 'ERROR';
                  const isWarn = item.level === 'WARN';

                  const badgeBg = isError
                    ? 'rgba(239, 68, 68, 0.15)'
                    : isWarn
                      ? 'rgba(245, 158, 11, 0.15)'
                      : item.category === 'CLASSIFIER'
                        ? 'rgba(16, 185, 129, 0.15)'
                        : item.category === 'WHATSAPP'
                          ? 'rgba(56, 189, 248, 0.15)'
                          : 'rgba(139, 92, 246, 0.15)';

                  const badgeColor = isError
                    ? '#f87171'
                    : isWarn
                      ? '#fbbf24'
                      : item.category === 'CLASSIFIER'
                        ? '#34d399'
                        : item.category === 'WHATSAPP'
                          ? '#38bdf8'
                          : '#c084fc';

                  return (
                    <div
                      key={item.id}
                      style={{
                        background: '#0f172a',
                        border: isError ? '1px solid rgba(239, 68, 68, 0.3)' : '1px solid #1e293b',
                        borderRadius: '6px',
                        padding: '0.6rem 0.8rem',
                        fontSize: '0.82rem'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem', flexWrap: 'wrap', gap: '0.4rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
                          <span
                            style={{
                              background: badgeBg,
                              color: badgeColor,
                              padding: '0.15rem 0.45rem',
                              borderRadius: '4px',
                              fontSize: '0.7rem',
                              fontWeight: 700,
                              textTransform: 'uppercase'
                            }}
                          >
                            {item.category}
                          </span>

                          <span style={{ fontSize: '0.7rem', color: '#64748b', fontFamily: 'monospace' }}>
                            {item.event}
                          </span>
                        </div>

                        <span style={{ fontSize: '0.72rem', color: '#64748b' }}>
                          {new Date(item.timestamp).toLocaleString('pt-BR')}
                        </span>
                      </div>

                      <div style={{ color: isError ? '#fca5a5' : '#f8fafc', fontWeight: 500, lineHeight: 1.4 }}>
                        {item.message}
                      </div>

                      {item.details && Object.keys(item.details).length > 0 && (
                        <div style={{ marginTop: '0.4rem' }}>
                          <button
                            type="button"
                            onClick={() => toggleExpandLog(item.id)}
                            style={{
                              background: 'transparent',
                              border: 'none',
                              color: '#38bdf8',
                              fontSize: '0.72rem',
                              cursor: 'pointer',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: '0.25rem',
                              padding: '0'
                            }}
                          >
                            {isExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                            {isExpanded ? 'Ocultar payload' : 'Ver payload estruturado { }'}
                          </button>

                          {isExpanded && (
                            <pre
                              style={{
                                marginTop: '0.4rem',
                                background: '#020617',
                                border: '1px solid #1e293b',
                                borderRadius: '4px',
                                padding: '0.5rem',
                                fontSize: '0.72rem',
                                color: '#93c5fd',
                                overflowX: 'auto',
                                maxHeight: '200px'
                              }}
                            >
                              {JSON.stringify(item.details, null, 2)}
                            </pre>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Bottom Footer */}
            <div style={{ marginTop: '0.8rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
              <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                Salvo em: <code>data/logs/activity-*.jsonl</code> (Retenção automática de 14 dias)
              </span>
              <button className="btn-action primary" onClick={() => setShowLogsModal(false)}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
