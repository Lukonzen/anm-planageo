(() => {
  "use strict";

  const ANM_QUERY = "https://geo.anm.gov.br/arcgis/rest/services/SIGMINE/dados_anm/FeatureServer/0/query";
  const SGB_QUERY = "https://geoportal.sgb.gov.br/server/rest/services/Hosted/Aerogeofisica/FeatureServer/1/query";
  const ANM_FIELDS = "PROCESSO,NUMERO,ANO,FASE,NOME,SUBS,USO,AREA_HA,UF,ULT_EVENTO,ID,OBJECTID,DSProcesso";
  const SGB_FIELDS = "objectid,num_projeto,projeto,metodo,ano_prev,processo_sei,direcao_lv,espacamento_lv,espacamento_lc,km_estimado,custo_estimado,area,objetivo,objeto_geologico,bioma,tempo_estimado,observacao,status,bloco";

  // Banco de Dados Aero do SGB (camada 0). O campo url_download NÃO é solicitado de propósito.
  const SGB_AERO_QUERY = "https://geoportal.sgb.gov.br/server/rest/services/Hosted/Aerogeofisica/FeatureServer/0/query";
  const AERO_FIELDS = "objectid,no_projeto,situacao,projeto,tema,esp_lv_m,esp_lc_km,alt_voo_m,direcao_lv,direcao_lc,area_km2,tt_perf_km,conclusao,contratant,entidade,serie,ano_proj";
  const AERO_BATCH = 200;

  // Séries do Banco de Dados Aero. "serieOutras" recebe qualquer valor de série não previsto.
  const SERIES = [
    { key: "serie1000", code: "1000", label: "Série 1000", color: "#65a30d", outline: "#4d7c0f" },
    { key: "serie2000", code: "2000", label: "Série 2000", color: "#b45309", outline: "#78350f" },
    { key: "serie3000", code: "3000", label: "Série 3000", color: "#db2777", outline: "#9d174d" },
    { key: "serie4000", code: "4000", label: "Série 4000", color: "#374151", outline: "#111827" },
    { key: "serieOutras", code: null, label: "Outras séries", color: "#0e7490", outline: "#155e75" }
  ];

  // Dados de contato que saem no relatório
  const CONTACT = {
    name: "Luciano Konzen",
    role: "Consultor em Geofísica Aérea e Terrestre",
    email: "lucianokonzen74@gmail.com",
    phone: "+55 77 99967-6532"
  };
  const CONTACT_CALL = "Entre em contato para realizar o reprocessamento, geração de mapas, interpretação ou modelagem dos dados dos projetos já executados.";

  // Grupos de métodos do Plangeo (atributo "metodo"), classificados por palavra-chave
  const METHOD_COLORS = { em: "#2563eb", gama: "#0d9488", grad: "#7c3aed", other: "#64748b" };

  const $ = (id) => document.getElementById(id);
  const statusEl = $("searchStatus");
  const resultsEl = $("results");
  const summaryEl = $("resultsSummary");
  const detailsEl = $("projectDetails");
  const projectSummaryEl = $("projectSummary");
  const searchButton = $("searchButton");

  let plangeoFeatures = [];
  let selectedResultButton = null;
  let activeTitleFeature = null;
  let activeTitleAttrs = null;
  let holderRun = 0; // identifica a execução atual (cancela execuções antigas)
  let plangeoBboxes = null;
  const MAX_HOLDER_TITLES = 3000;
  const HOLDER_PAGE = 500;
  const HOLDER_LABEL = "Mostrar todos os títulos com mesma titularidade";
  const holderButton = $("holderButton");
  const holderHint = $("holderHint");
  const reportButton = $("reportButton");
  const reportHint = $("reportHint");
  let lastResult = null; // último cruzamento (título único ou todos os títulos do titular)
  const seriesData = {}; // key -> { features: [...], bboxes: [...] }

  const map = new maplibregl.Map({
    container: "map",
    center: [-52, -14],
    zoom: 3.4,
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          attribution: "© OpenStreetMap contributors"
        }
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }]
    }
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }));

  function setStatus(message, isError = false) {
    statusEl.textContent = message;
    statusEl.classList.toggle("error", isError);
  }

  const EMPTY_FC = () => ({ type: "FeatureCollection", features: [] });

  /* ---------------------------------------------------------------
   * Classificação dos métodos do Plangeo
   * ------------------------------------------------------------- */
  function normalize(text) {
    return String(text || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/\s+/g, " ").trim();
  }

  function classifyMethod(metodo) {
    const m = normalize(metodo);
    if (m.includes("eletromagnetico")) return "em";
    if (m.includes("gamaespectrometria")) return "gama";
    if (m.includes("gradiometri")) return "grad";
    return "other";
  }

  /* ---------------------------------------------------------------
   * Camadas do mapa (criadas vazias; os dados entram depois)
   * ------------------------------------------------------------- */
  function initLayers() {
    // Séries do Banco de Dados Aero (ficam abaixo do Plangeo)
    for (const s of SERIES) {
      map.addSource(s.key, { type: "geojson", data: EMPTY_FC() });
      map.addLayer({
        id: `${s.key}-fill`, type: "fill", source: s.key,
        paint: { "fill-color": s.color, "fill-opacity": 0.25 }
      });
      map.addLayer({
        id: `${s.key}-line`, type: "line", source: s.key,
        paint: { "line-color": s.outline, "line-width": 1.2 }
      });
    }

    // Plangeo, colorido por grupo de método
    const groupColor = [
      "match", ["get", "_grp"],
      "em", METHOD_COLORS.em,
      "gama", METHOD_COLORS.gama,
      "grad", METHOD_COLORS.grad,
      METHOD_COLORS.other
    ];
    map.addSource("plangeo", { type: "geojson", data: EMPTY_FC() });
    map.addLayer({
      id: "plangeo-fill", type: "fill", source: "plangeo",
      paint: { "fill-color": groupColor, "fill-opacity": 0.25 }
    });
    map.addLayer({
      id: "plangeo-line", type: "line", source: "plangeo",
      paint: { "line-color": groupColor, "line-width": 1.5 }
    });

    // Todos os títulos do mesmo titular
    map.addSource("holder-titles", { type: "geojson", data: EMPTY_FC() });
    map.addLayer({
      id: "holder-fill", type: "fill", source: "holder-titles",
      paint: { "fill-color": "#ef4444", "fill-opacity": 0.1 }
    });
    map.addLayer({
      id: "holder-line", type: "line", source: "holder-titles",
      paint: { "line-color": "#d72e2e", "line-width": 1.2, "line-dasharray": [3, 2] }
    });

    // Destaques: projetos Plangeo e séries que intersectam o título
    map.addSource("selected-projects", { type: "geojson", data: EMPTY_FC() });
    map.addLayer({
      id: "selected-projects-fill", type: "fill", source: "selected-projects",
      paint: { "fill-color": "#f59e0b", "fill-opacity": 0.5 }
    });
    map.addLayer({
      id: "selected-projects-line", type: "line", source: "selected-projects",
      paint: { "line-color": "#b86b00", "line-width": 3 }
    });
    for (const s of SERIES) {
      map.addSource(`selected-${s.key}`, { type: "geojson", data: EMPTY_FC() });
      map.addLayer({
        id: `selected-${s.key}-fill`, type: "fill", source: `selected-${s.key}`,
        paint: { "fill-color": "#f59e0b", "fill-opacity": 0.5 }
      });
      map.addLayer({
        id: `selected-${s.key}-line`, type: "line", source: `selected-${s.key}`,
        paint: { "line-color": "#b86b00", "line-width": 3 }
      });
    }

    // Título ANM selecionado (por cima de tudo)
    map.addSource("selected-title", { type: "geojson", data: EMPTY_FC() });
    map.addLayer({
      id: "selected-title-fill", type: "fill", source: "selected-title",
      paint: { "fill-color": "#ef4444", "fill-opacity": 0.14 }
    });
    map.addLayer({
      id: "selected-title-line", type: "line", source: "selected-title",
      paint: { "line-color": "#d72e2e", "line-width": 2.5 }
    });

    // Clique: mostra todos os polígonos visíveis sob o cursor
    const clickable = [
      "holder-fill",
      "plangeo-fill",
      ...SERIES.map(s => `${s.key}-fill`)
    ];
    map.on("click", (event) => {
      const hits = map.queryRenderedFeatures(event.point, { layers: clickable });
      if (!hits.length) return;
      const items = [];
      const seen = new Set();
      for (const h of hits) {
        const kind = h.layer.id.replace("-fill", "");
        const id = kind === "plangeo" ? `p-${h.properties.objectid}`
          : kind === "holder" ? `h-${h.properties.OBJECTID}`
          : h.properties._sid;
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({ kind, props: h.properties });
      }
      showClickDetails(items);
    });
    map.on("mousemove", (event) => {
      const hit = map.queryRenderedFeatures(event.point, { layers: clickable }).length > 0;
      map.getCanvas().style.cursor = hit ? "pointer" : "";
    });
  }

  /* ---------------------------------------------------------------
   * Visibilidade das camadas (checkboxes)
   * ------------------------------------------------------------- */
  const layerChecks = () => Array.from(document.querySelectorAll("input[data-layer]"));

  function applyVisibility() {
    const checked = new Set(layerChecks().filter(c => c.checked).map(c => c.dataset.layer));

    // Plangeo: filtro por grupo de método (vale para a camada base e para o destaque)
    const visibleGroups = ["em", "gama", "grad", "other"].filter(g => checked.has(g));
    const groupFilter = ["in", ["get", "_grp"], ["literal", visibleGroups]];
    for (const id of ["plangeo-fill", "plangeo-line", "selected-projects-fill", "selected-projects-line"]) {
      if (map.getLayer(id)) map.setFilter(id, groupFilter);
    }

    // Séries: liga/desliga a camada base e o destaque
    for (const s of SERIES) {
      const v = checked.has(s.key) ? "visible" : "none";
      for (const id of [`${s.key}-fill`, `${s.key}-line`, `selected-${s.key}-fill`, `selected-${s.key}-line`]) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", v);
      }
    }
    syncGroupCheckboxes();
  }

  function syncGroupCheckboxes() {
    for (const [groupId, groupName] of [["groupPlangeo", "plangeo"], ["groupAero", "aero"]]) {
      const boxes = Array.from(document.querySelectorAll(`.layer-group[data-group="${groupName}"] input[data-layer]`))
        .filter(b => !b.closest("[hidden]"));
      const on = boxes.filter(b => b.checked).length;
      const master = $(groupId);
      master.checked = on === boxes.length && boxes.length > 0;
      master.indeterminate = on > 0 && on < boxes.length;
    }
  }

  function setupLayerPanel() {
    layerChecks().forEach(c => c.addEventListener("change", applyVisibility));
    for (const [groupId, groupName] of [["groupPlangeo", "plangeo"], ["groupAero", "aero"]]) {
      $(groupId).addEventListener("change", (event) => {
        document.querySelectorAll(`.layer-group[data-group="${groupName}"] input[data-layer]`)
          .forEach(b => { b.checked = event.target.checked; });
        applyVisibility();
      });
    }
  }

  function setCount(key, n) {
    const el = document.querySelector(`[data-count="${key}"]`);
    if (el) el.textContent = `(${n.toLocaleString("pt-BR")})`;
  }

  /* ---------------------------------------------------------------
   * Rede
   * ------------------------------------------------------------- */
  async function postQuery(endpoint, params) {
    const response = await fetch(endpoint, {
      method: "POST",
      body: new URLSearchParams(params)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ao consultar o serviço`);
    const data = await response.json();
    if (data.error) {
      const detail = data.error.message || JSON.stringify(data.error);
      throw new Error(detail);
    }
    return data;
  }

  async function loadPlangeo() {
    const idData = await postQuery(SGB_QUERY, {
      where: "1=1",
      returnIdsOnly: "true",
      f: "json"
    });
    const ids = idData.objectIds || [];
    if (!ids.length) {
      plangeoFeatures = [];
      return;
    }

    const all = [];
    const batchSize = 100;
    for (let i = 0; i < ids.length; i += batchSize) {
      const chunk = ids.slice(i, i + batchSize);
      const data = await postQuery(SGB_QUERY, {
        objectIds: chunk.join(","),
        outFields: SGB_FIELDS,
        returnGeometry: "true",
        outSR: "4326",
        f: "geojson"
      });
      all.push(...(data.features || []));
      projectSummaryEl.textContent = `Carregando projetos Plangeo: ${all.length} de ${ids.length}…`;
    }

    // Classifica cada projeto por grupo de método
    const counts = { em: 0, gama: 0, grad: 0, other: 0 };
    for (const f of all) {
      f.properties = f.properties || {};
      f.properties._grp = classifyMethod(f.properties.metodo);
      counts[f.properties._grp]++;
    }
    plangeoFeatures = all;
    map.getSource("plangeo").setData({ type: "FeatureCollection", features: plangeoFeatures });

    for (const [k, n] of Object.entries(counts)) setCount(k, n);
    if (counts.other > 0) {
      $("otherLayerRow").hidden = false;
      syncGroupCheckboxes();
    }
    applyVisibility();
  }

  // Descobre a série (1000, 2000, 3000, 4000…) pelo atributo "serie" ou, na falta, pelo nº do projeto
  function serieKeyOf(props) {
    const fromText = (t) => {
      const m = String(t == null ? "" : t).match(/(?:^|\D)(\d)\d{3}(?!\d)/);
      return m ? `${m[1]}000` : null;
    };
    const code = fromText(props.serie) || fromText(props.no_projeto);
    const def = SERIES.find(s => s.code === code);
    return def ? def.key : "serieOutras";
  }

  async function loadAero() {
    const idData = await postQuery(SGB_AERO_QUERY, { where: "1=1", returnIdsOnly: "true", f: "json" });
    const ids = idData.objectIds || [];
    const groups = {};
    SERIES.forEach(s => { groups[s.key] = []; });

    const chunks = [];
    for (let i = 0; i < ids.length; i += AERO_BATCH) chunks.push(ids.slice(i, i + AERO_BATCH));
    let next = 0;
    let loaded = 0;
    const worker = async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        const data = await postQuery(SGB_AERO_QUERY, {
          objectIds: chunk.join(","),
          outFields: AERO_FIELDS,
          returnGeometry: "true",
          outSR: "4326",
          geometryPrecision: "5",
          f: "geojson"
        });
        for (const f of data.features || []) {
          if (!f || !f.geometry) continue;
          const props = { ...(f.properties || {}) };
          // garantia extra: nunca guardar campos de download
          for (const k of Object.keys(props)) if (/url|download/i.test(k)) delete props[k];
          const key = serieKeyOf(props);
          props._sid = `${key}-${props.objectid != null ? props.objectid : groups[key].length}`;
          groups[key].push({ type: "Feature", geometry: f.geometry, properties: props });
        }
        loaded += chunk.length;
        projectSummaryEl.textContent = `Carregando Banco de Dados Aero: ${loaded} de ${ids.length}…`;
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, worker));

    const counts = {};
    for (const s of SERIES) {
      const features = groups[s.key];
      seriesData[s.key] = { features, bboxes: features.map(f => turf.bbox(f)) };
      map.getSource(s.key).setData({ type: "FeatureCollection", features });
      setCount(s.key, features.length);
      counts[s.key] = features.length;
    }
    if (counts.serieOutras > 0) {
      $("serieOutrasRow").hidden = false;
      syncGroupCheckboxes();
    }
    applyVisibility();
    return counts;
  }

  async function loadAllData() {
    const [plangeoResult, aeroResult] = await Promise.allSettled([loadPlangeo(), loadAero()]);

    const errors = [];
    if (plangeoResult.status === "rejected") {
      projectSummaryEl.textContent = "Não foi possível carregar os polígonos Plangeo.";
      errors.push(`Plangeo: ${plangeoResult.reason.message}`);
    }
    let aeroInfo = "";
    if (aeroResult.status === "fulfilled") {
      aeroInfo = SERIES
        .filter(s => s.code || aeroResult.value[s.key] > 0)
        .map(s => `${s.label}: ${aeroResult.value[s.key]}`)
        .join(" · ");
    } else {
      errors.push(`Banco de Dados Aero: ${aeroResult.reason.message}`);
    }

    if (plangeoResult.status === "fulfilled") {
      projectSummaryEl.textContent =
        `${plangeoFeatures.length} projetos Plangeo carregados do SGB` +
        (aeroInfo ? ` · Banco de Dados Aero — ${aeroInfo}.` : ".");
    } else if (aeroInfo) {
      projectSummaryEl.textContent = `Banco de Dados Aero — ${aeroInfo}.`;
    }
    if (errors.length) {
      setStatus(`Falha ao carregar: ${errors.join(" | ")}. Verifique a conexão e possíveis restrições de CORS.`, true);
    } else {
      setStatus("Camadas carregadas. Busque um título ANM.");
    }
  }

  /* ---------------------------------------------------------------
   * Busca de títulos ANM
   * ------------------------------------------------------------- */
  function escapeSql(value) {
    return value.trim().replace(/'/g, "''");
  }

  function buildWhere(type, raw) {
    const term = escapeSql(raw);
    if (!term) throw new Error("Digite um termo para buscar.");
    if (type === "processo") {
      // Pesquisa parcial nos formatos numérico e formatado do processo.
      return `(PROCESSO LIKE '%${term}%' OR DSProcesso LIKE '%${term}%')`;
    }
    if (type === "titular") return `UPPER(NOME) LIKE '%${term.toUpperCase()}%'`;
    return `UPPER(SUBS) LIKE '%${term.toUpperCase()}%'`;
  }

  function clearResults() {
    resultsEl.replaceChildren();
    summaryEl.textContent = "";
    selectedResultButton = null;
  }

  function textEl(tag, text, className) {
    const el = document.createElement(tag);
    el.textContent = text == null || text === "" ? "—" : String(text);
    if (className) el.className = className;
    return el;
  }

  async function searchTitles() {
    const type = $("searchType").value;
    const raw = $("searchInput").value;
    let where;
    try { where = buildWhere(type, raw); }
    catch (error) { setStatus(error.message, true); return; }

    searchButton.disabled = true;
    clearResults();
    setStatus("Consultando a base pública da ANM…");
    try {
      const countData = await postQuery(ANM_QUERY, {
        where,
        returnCountOnly: "true",
        f: "json"
      });
      const total = Number(countData.count || 0);
      if (!total) {
        summaryEl.textContent = "Nenhum título encontrado.";
        setStatus("Busca concluída.");
        return;
      }
      const data = await postQuery(ANM_QUERY, {
        where,
        outFields: ANM_FIELDS,
        returnGeometry: "false",
        orderByFields: type === "titular" ? "NOME ASC" : "PROCESSO ASC",
        resultRecordCount: "100",
        f: "json"
      });
      const features = data.features || [];
      summaryEl.textContent = `${total.toLocaleString("pt-BR")} resultado(s) na ANM; exibindo ${features.length}${total > features.length ? " (lista limitada a 100)" : ""}.`;
      for (const feature of features) {
        const attrs = feature.attributes || {};
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "result-item";
        const title = attrs.DSProcesso || attrs.PROCESSO || `ObjectID ${attrs.OBJECTID}`;
        const holder = attrs.NOME || "Titular não informado";
        btn.append(textEl("strong", `${title} — ${holder}`));
        btn.append(textEl("span", `${attrs.SUBS || "Substância não informada"} · ${attrs.FASE || "Fase não informada"} · ${attrs.UF || "UF não informada"}`));
        btn.append(textEl("span", `Área: ${formatArea(attrs.AREA_HA)} ha`));
        btn.addEventListener("click", () => selectTitle(attrs, btn));
        resultsEl.append(btn);
      }
      setStatus(total > features.length
        ? "Busca concluída. Há mais resultados do que os exibidos; refine o termo para reduzir a lista."
        : "Busca concluída. Selecione um título para cruzá-lo com Plangeo e séries.");
    } catch (error) {
      setStatus(`Falha na consulta ANM: ${error.message}. Se for erro de CORS, será necessário um intermediário de servidor.`, true);
    } finally {
      searchButton.disabled = false;
    }
  }

  function formatArea(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString("pt-BR", { maximumFractionDigits: 2 }) : "—";
  }

  /* ---------------------------------------------------------------
   * Cruzamento título × (Plangeo + séries)
   * ------------------------------------------------------------- */
  function intersectSeries(titleFeature) {
    const tb = turf.bbox(titleFeature);
    const out = {};
    for (const s of SERIES) {
      const data = seriesData[s.key];
      out[s.key] = [];
      if (!data) continue;
      data.features.forEach((f, i) => {
        const b = data.bboxes[i];
        // descarta rápido por caixa envolvente
        if (b[0] > tb[2] || b[2] < tb[0] || b[1] > tb[3] || b[3] < tb[1]) return;
        try {
          if (turf.booleanIntersects(titleFeature, f)) out[s.key].push(f);
        } catch (e) {
          console.warn(`Geometria inválida em ${s.key} (${f.properties._sid}):`, e);
        }
      });
    }
    return out;
  }

  async function selectTitle(attrs, button) {
    if (selectedResultButton) selectedResultButton.classList.remove("active");
    selectedResultButton = button;
    button.classList.add("active");
    clearHolder();
    activeTitleAttrs = null;
    updateHolderButton();
    lastResult = null;
    updateReportButton();
    setStatus(`Obtendo geometria do processo ${attrs.PROCESSO || attrs.DSProcesso || attrs.OBJECTID}…`);
    try {
      const geometryData = await postQuery(ANM_QUERY, {
        objectIds: String(attrs.OBJECTID),
        outFields: ANM_FIELDS,
        returnGeometry: "true",
        outSR: "4326",
        f: "geojson"
      });
      const titleFeature = geometryData.features && geometryData.features[0];
      if (!titleFeature || !titleFeature.geometry) throw new Error("A ANM não retornou a geometria desse título.");
      activeTitleFeature = titleFeature;
      map.getSource("selected-title").setData({ type: "FeatureCollection", features: [titleFeature] });

      // Plangeo: interseção feita pelo serviço do SGB
      const arcGeometry = geoJsonToEsriPolygon(titleFeature.geometry);
      const intersectionData = await postQuery(SGB_QUERY, {
        where: "1=1",
        geometry: JSON.stringify(arcGeometry),
        geometryType: "esriGeometryPolygon",
        inSR: "4326",
        spatialRel: "esriSpatialRelIntersects",
        outFields: SGB_FIELDS,
        returnGeometry: "false",
        f: "json"
      });
      const matches = (intersectionData.features || []).map(f => f.attributes);
      const ids = new Set(matches.map(p => String(p.objectid)));
      const selectedFeatures = plangeoFeatures.filter(f => ids.has(String(f.properties?.objectid)));
      map.getSource("selected-projects").setData({ type: "FeatureCollection", features: selectedFeatures });

      // Séries do Banco de Dados Aero: interseção feita no navegador (Turf.js)
      const seriesMatches = intersectSeries(titleFeature);
      for (const s of SERIES) {
        map.getSource(`selected-${s.key}`).setData({ type: "FeatureCollection", features: seriesMatches[s.key] });
      }

      activeTitleAttrs = attrs;
      updateHolderButton();
      lastResult = {
        mode: "title", holder: null, total: 1,
        titles: [attrs],
        plangeo: matches.map(p => ({ props: p, hits: [attrs] })),
        series: Object.fromEntries(SERIES.map(s => [s.key, seriesMatches[s.key].map(f => ({ props: f.properties, hits: [attrs] }))]))
      };
      updateReportButton();
      showTitleDetails(attrs, matches, seriesMatches);
      fitGeometry(titleFeature.geometry);
      const serieTotal = SERIES.reduce((n, s) => n + seriesMatches[s.key].length, 0);
      setStatus(`Título selecionado. Interseção com ${matches.length} projeto(s) Plangeo e ${serieTotal} polígono(s) das séries.`);
    } catch (error) {
      setStatus(`Não foi possível cruzar este título: ${error.message}`, true);
    }
  }

  function geoJsonToEsriPolygon(geometry) {
    if (geometry.type === "Polygon") {
      return { rings: geometry.coordinates, spatialReference: { wkid: 4326 } };
    }
    if (geometry.type === "MultiPolygon") {
      return { rings: geometry.coordinates.flat(), spatialReference: { wkid: 4326 } };
    }
    throw new Error(`Tipo de geometria não suportado: ${geometry.type}`);
  }

  function fitGeometry(geometry) {
    const coords = [];
    const walk = (value) => {
      if (!Array.isArray(value)) return;
      if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") {
        coords.push(value);
      } else {
        value.forEach(walk);
      }
    };
    walk(geometry.coordinates);
    if (!coords.length) return;
    const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    map.fitBounds(bounds, { padding: 60, maxZoom: 11, duration: 700 });
  }

  /* ---------------------------------------------------------------
   * Painel de detalhes
   * ------------------------------------------------------------- */
  function showTitleDetails(properties, plangeoMatches, seriesMatches) {
    detailsEl.replaceChildren();
    const dl = document.createElement("dl");
    const rows = [
      ["Processo", properties.DSProcesso || properties.PROCESSO],
      ["Titular", properties.NOME],
      ["Substância", properties.SUBS],
      ["Fase", properties.FASE],
      ["UF", properties.UF],
      ["Área (ha)", formatArea(properties.AREA_HA)],
      ["Último evento", properties.ULT_EVENTO]
    ];
    for (const [label, value] of rows) {
      dl.append(textEl("dt", label), textEl("dd", value));
    }
    detailsEl.append(dl);

    detailsEl.append(textEl("h3", `Plangeo — interseções: ${plangeoMatches.length}`, "subhead"));
    if (!plangeoMatches.length) {
      detailsEl.append(textEl("p", "Nenhum polígono Plangeo intersectou este título.", "muted"));
    }
    for (const p of plangeoMatches) detailsEl.append(projectCard(p));

    for (const s of SERIES) {
      const list = seriesMatches[s.key] || [];
      detailsEl.append(textEl("h3", `${s.label} — interseções: ${list.length}`, "subhead"));
      if (!list.length) {
        detailsEl.append(textEl("p", `Nenhum polígono da ${s.label} intersectou este título.`, "muted"));
      }
      for (const f of list) detailsEl.append(serieCard(s, f.properties));
    }
  }

  function showClickDetails(items) {
    detailsEl.replaceChildren();
    for (const item of items) {
      if (item.kind === "plangeo") {
        detailsEl.append(projectCard(item.props));
      } else if (item.kind === "holder") {
        detailsEl.append(titleCard(item.props));
      } else {
        const s = SERIES.find(x => x.key === item.kind);
        detailsEl.append(serieCard(s, item.props));
      }
    }
  }

  function projectTitle(p) {
    const name = p.projeto || `Projeto ${p.num_projeto || p.objectid || ""}`;
    return `${p.num_projeto || ""} ${name}`.trim();
  }

  function projectLines(p) {
    const lines = [
      `Bloco: ${p.bloco || "—"} · Previsão: ${p.ano_prev || "não informada"}`,
      `Métodos: ${p.metodo || "não informado"}`
    ];
    if (p.area != null) lines.push(`Área informada pelo SGB: ${formatArea(p.area)} km²`);
    if (p.km_estimado != null) lines.push(`Extensão estimada: ${Number(p.km_estimado).toLocaleString("pt-BR", { maximumFractionDigits: 0 })} km`);
    if (p.status) lines.push(`Status: ${p.status}`);
    return lines;
  }

  function projectCard(p, extra) {
    const card = document.createElement("div");
    card.className = "project-link";
    card.append(textEl("strong", projectTitle(p)));
    for (const line of projectLines(p)) card.append(textEl("p", line));
    if (extra) card.append(textEl("p", extra));
    return card;
  }

  // Atributos do Banco de Dados Aero que aparecem para o usuário.
  // O campo url_download (link de download) fica de fora de propósito.
  const AERO_LABELS = [
    ["no_projeto", "Nº do projeto", "raw"],
    ["situacao", "Situação"],
    ["tema", "Metodologia"],
    ["ano_proj", "Ano de execução", "year"],
    ["esp_lv_m", "Espaçamento das linhas de voo (m)"],
    ["esp_lc_km", "Espaçamento das linhas de controle (km)"],
    ["alt_voo_m", "Altura de voo (m)"],
    ["direcao_lv", "Direção das linhas de voo"],
    ["direcao_lc", "Direção das linhas de controle"],
    ["area_km2", "Área (km²)"],
    ["tt_perf_km", "Quilometragem voada (km)"],
    ["conclusao", "Conclusão"],
    ["contratant", "Contratante"],
    ["entidade", "Contratada"]
  ];

  function serieInfo(serie, props) {
    const name = props.projeto || props.no_projeto;
    const title = name ? `${serie.label} — ${name}` : serie.label;
    const lines = [];
    for (const [key, label, kind] of AERO_LABELS) {
      const v = props[key];
      if (v == null || v === "" || v === "null") continue;
      let shown = v;
      if (kind === "raw") shown = String(v);
      else if (kind === "year") shown = String(Math.round(Number(v)) || v);
      else if (typeof v === "number") shown = formatArea(v);
      lines.push(`${label}: ${shown}`);
    }
    if (serie.code === null && props.serie) lines.push(`Série informada: ${props.serie}`);
    return { title, lines };
  }

  function serieCard(serie, props, extra) {
    const card = document.createElement("div");
    card.className = "project-link";
    const info = serieInfo(serie, props);
    card.append(textEl("strong", info.title));
    for (const line of info.lines) card.append(textEl("p", line, "kv"));
    if (extra) card.append(textEl("p", extra));
    return card;
  }

  /* ---------------------------------------------------------------
   * Todos os títulos do mesmo titular
   * ------------------------------------------------------------- */
  const sleep0 = () => new Promise(resolve => setTimeout(resolve, 0));
  const procLabel = (p) => p.DSProcesso || p.PROCESSO || `ObjectID ${p.OBJECTID}`;

  function clearHolder() {
    holderRun++; // cancela qualquer carga em andamento
    const src = map.getSource("holder-titles");
    if (src) src.setData(EMPTY_FC());
  }

  function updateHolderButton() {
    const name = activeTitleAttrs && activeTitleAttrs.NOME ? String(activeTitleAttrs.NOME).trim() : "";
    holderButton.disabled = !name;
    holderButton.textContent = HOLDER_LABEL;
    holderHint.textContent = name
      ? `Titular do título selecionado: ${name}`
      : activeTitleAttrs
        ? "O título selecionado não tem titular informado."
        : "Selecione um título para ativar.";
  }

  async function fetchHolderTitles(holder, run) {
    const where = `UPPER(NOME) = UPPER('${escapeSql(holder)}')`;
    const countData = await postQuery(ANM_QUERY, { where, returnCountOnly: "true", f: "json" });
    if (run !== holderRun) return null;
    const total = Number(countData.count || 0);
    const limit = Math.min(total, MAX_HOLDER_TITLES);
    const titles = [];
    for (let offset = 0; offset < limit; offset += HOLDER_PAGE) {
      setStatus(`Carregando títulos de ${holder}: ${titles.length} de ${limit}…`);
      const data = await postQuery(ANM_QUERY, {
        where,
        outFields: ANM_FIELDS,
        returnGeometry: "true",
        outSR: "4326",
        geometryPrecision: "6",
        orderByFields: "OBJECTID ASC",
        resultOffset: String(offset),
        resultRecordCount: String(Math.min(HOLDER_PAGE, limit - offset)),
        f: "geojson"
      });
      if (run !== holderRun) return null;
      titles.push(...(data.features || []).filter(f => f.geometry));
    }
    return { titles, total };
  }

  // Cruza cada alvo (Plangeo ou série) com todos os títulos; descarta por bbox antes de testar.
  async function crossHolder(titles, titleBoxes, targets, targetBoxes, run, label) {
    const out = [];
    for (let i = 0; i < targets.length; i++) {
      const b = targetBoxes[i];
      const hits = [];
      for (let j = 0; j < titles.length; j++) {
        const tb = titleBoxes[j];
        if (b[0] > tb[2] || b[2] < tb[0] || b[1] > tb[3] || b[3] < tb[1]) continue;
        try {
          if (turf.booleanIntersects(titles[j], targets[i])) hits.push(titles[j].properties);
        } catch (e) { /* geometria inválida: ignora */ }
      }
      if (hits.length) out.push({ feature: targets[i], hits });
      if (i % 25 === 24) {
        setStatus(`Cruzando ${label}: ${i + 1} de ${targets.length}…`);
        await sleep0();
        if (run !== holderRun) return null;
      }
    }
    out.sort((x, y) => y.hits.length - x.hits.length);
    return out;
  }

  async function showHolderTitles() {
    if (!activeTitleAttrs) return;
    const holder = String(activeTitleAttrs.NOME || "").trim();
    if (!holder) return;
    const run = ++holderRun;
    holderButton.disabled = true;
    holderButton.textContent = "Carregando títulos…";
    try {
      const fetched = await fetchHolderTitles(holder, run);
      if (!fetched) return;
      const { titles, total } = fetched;
      if (!titles.length) throw new Error("A ANM não retornou títulos para este titular.");
      map.getSource("holder-titles").setData({ type: "FeatureCollection", features: titles });

      const titleBoxes = titles.map(t => turf.bbox(t));
      if (!plangeoBboxes || plangeoBboxes.length !== plangeoFeatures.length) {
        plangeoBboxes = plangeoFeatures.map(f => turf.bbox(f));
      }

      const plangeoRes = await crossHolder(titles, titleBoxes, plangeoFeatures, plangeoBboxes, run, "Plangeo");
      if (!plangeoRes) return;
      const seriesRes = {};
      for (const s of SERIES) {
        const d = seriesData[s.key] || { features: [], bboxes: [] };
        const r = await crossHolder(titles, titleBoxes, d.features, d.bboxes, run, s.label);
        if (!r) return;
        seriesRes[s.key] = r;
      }

      // Destaques no mapa
      map.getSource("selected-projects").setData({
        type: "FeatureCollection", features: plangeoRes.map(r => r.feature)
      });
      for (const s of SERIES) {
        map.getSource(`selected-${s.key}`).setData({
          type: "FeatureCollection", features: seriesRes[s.key].map(r => r.feature)
        });
      }

      lastResult = {
        mode: "holder", holder, total,
        titles: titles.map(t => t.properties),
        plangeo: plangeoRes.map(r => ({ props: r.feature.properties, hits: r.hits })),
        series: Object.fromEntries(SERIES.map(s => [s.key, seriesRes[s.key].map(r => ({ props: r.feature.properties, hits: r.hits }))]))
      };
      updateReportButton();
      showHolderDetails(holder, titles, total, plangeoRes, seriesRes);
      const b = turf.bbox({ type: "FeatureCollection", features: titles });
      map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 60, maxZoom: 11, duration: 700 });

      const serieTotal = SERIES.reduce((n, s) => n + seriesRes[s.key].length, 0);
      setStatus(
        `${titles.length} título(s) de ${holder}` +
        (total > titles.length ? ` (limitado a ${MAX_HOLDER_TITLES} de ${total.toLocaleString("pt-BR")})` : "") +
        `. Interseção com ${plangeoRes.length} projeto(s) Plangeo e ${serieTotal} polígono(s) das séries.`,
        total > titles.length
      );
    } catch (error) {
      setStatus(`Não foi possível carregar os títulos do titular: ${error.message}`, true);
    } finally {
      if (run === holderRun) updateHolderButton();
    }
  }

  function hitsLine(hits) {
    const names = hits.slice(0, 5).map(procLabel).join(", ");
    return `Títulos do titular intersectados: ${hits.length} — ${names}${hits.length > 5 ? `, +${hits.length - 5}` : ""}`;
  }

  function showHolderDetails(holder, titles, total, plangeoRes, seriesRes) {
    detailsEl.replaceChildren();
    const area = titles.reduce((sum, t) => sum + (Number(t.properties.AREA_HA) || 0), 0);
    const dl = document.createElement("dl");
    dl.append(textEl("dt", "Titular"), textEl("dd", holder));
    dl.append(textEl("dt", "Títulos no mapa"), textEl("dd", titles.length.toLocaleString("pt-BR")));
    if (total > titles.length) dl.append(textEl("dt", "Total na ANM"), textEl("dd", total.toLocaleString("pt-BR")));
    dl.append(textEl("dt", "Área somada (ha)"), textEl("dd", formatArea(area)));
    detailsEl.append(dl);

    detailsEl.append(textEl("h3", `Plangeo — interseções: ${plangeoRes.length}`, "subhead"));
    if (!plangeoRes.length) detailsEl.append(textEl("p", "Nenhum polígono Plangeo intersectou os títulos deste titular.", "muted"));
    for (const r of plangeoRes) detailsEl.append(projectCard(r.feature.properties, hitsLine(r.hits)));

    for (const s of SERIES) {
      const list = seriesRes[s.key] || [];
      detailsEl.append(textEl("h3", `${s.label} — interseções: ${list.length}`, "subhead"));
      if (!list.length) detailsEl.append(textEl("p", `Nenhum polígono da ${s.label} intersectou os títulos deste titular.`, "muted"));
      for (const r of list) detailsEl.append(serieCard(s, r.feature.properties, hitsLine(r.hits)));
    }
  }

  function titleCard(p) {
    const card = document.createElement("div");
    card.className = "project-link";
    card.append(textEl("strong", `${procLabel(p)} — ${p.NOME || "Titular não informado"}`));
    card.append(textEl("p", `${p.SUBS || "Substância não informada"} · ${p.FASE || "Fase não informada"} · ${p.UF || "UF não informada"}`));
    card.append(textEl("p", `Área: ${formatArea(p.AREA_HA)} ha`));
    return card;
  }

  /* ---------------------------------------------------------------
   * Relatório em texto
   * ------------------------------------------------------------- */
  function updateReportButton() {
    reportButton.disabled = !lastResult;
    if (!lastResult) {
      reportHint.textContent = "Selecione um título para ativar.";
    } else if (lastResult.mode === "holder") {
      reportHint.textContent = `Relatório de ${lastResult.titles.length} título(s) de ${lastResult.holder}.`;
    } else {
      reportHint.textContent = `Relatório do título ${procLabel(lastResult.titles[0])}.`;
    }
  }

  // Quebra uma lista de itens em linhas de largura limitada
  function wrapItems(label, items, indent = "    ", width = 78) {
    const out = [];
    let line = indent + label;
    let hasItems = false;
    items.forEach((item, i) => {
      const piece = item + (i < items.length - 1 ? "; " : "");
      if (hasItems && line.length + piece.length > width) {
        out.push(line.trimEnd());
        line = indent + "  ";
        hasItems = false;
      }
      line += piece;
      hasItems = true;
    });
    out.push(line.trimEnd());
    return out;
  }

  function contactBlock(L) {
    L.push(
      "CONTATO",
      CONTACT_CALL,
      "",
      `${CONTACT.name} — ${CONTACT.role}`,
      `E-mail: ${CONTACT.email}`,
      `Telefone: ${CONTACT.phone}`,
      ""
    );
  }

  function buildReport() {
    const r = lastResult;
    const L = [];
    const bar = "=".repeat(78);
    const thin = "-".repeat(78);
    const dash = (v) => (v == null || v === "" ? "—" : v);

    L.push(bar, "RELATÓRIO DE SOBREPOSIÇÃO — PLANGEO × TÍTULOS ANM", bar,
      `Emitido em: ${new Date().toLocaleString("pt-BR")}`, "");
    contactBlock(L);

    // Resumo
    const areaHa = r.titles.reduce((sum, t) => sum + (Number(t.AREA_HA) || 0), 0);
    L.push(thin, "RESUMO", thin);
    if (r.mode === "holder") {
      L.push(`Titular: ${r.holder}`);
      L.push(`Títulos analisados: ${r.titles.length.toLocaleString("pt-BR")}` +
        (r.total > r.titles.length ? ` (de ${r.total.toLocaleString("pt-BR")} na ANM; lista limitada)` : ""));
    } else {
      L.push(`Processo: ${procLabel(r.titles[0])}`);
      L.push(`Titular: ${dash(r.titles[0].NOME)}`);
    }
    L.push(`Área somada dos títulos (ha): ${formatArea(areaHa)}`);
    L.push(`Projetos Plangeo com interseção: ${r.plangeo.length}`);
    for (const s of SERIES) {
      const n = r.series[s.key].length;
      if (s.code || n > 0) L.push(`${s.label} — polígonos com interseção: ${n}`);
    }
    L.push("");

    // Títulos analisados
    L.push(thin, "TÍTULOS ANALISADOS", thin);
    r.titles.forEach((t, i) => {
      L.push(`${i + 1}. ${procLabel(t)} — ${dash(t.NOME)}`);
      L.push(`    ${dash(t.SUBS)} · ${dash(t.FASE)} · ${dash(t.UF)} · ${formatArea(t.AREA_HA)} ha`);
    });
    L.push("");

    // Plangeo
    L.push(thin, `PROJETOS PLANGEO COM INTERSEÇÃO (${r.plangeo.length})`, thin);
    if (!r.plangeo.length) L.push("Nenhum polígono Plangeo intersectou os títulos analisados.");
    r.plangeo.forEach((item, i) => {
      L.push(`[${i + 1}] ${projectTitle(item.props)}`);
      for (const line of projectLines(item.props)) L.push(`    ${line}`);
      L.push(...wrapItems(`Títulos intersectados (${item.hits.length}): `, item.hits.map(procLabel)));
      L.push("");
    });
    if (r.plangeo.length) L.push("");

    // Séries
    for (const s of SERIES) {
      const list = r.series[s.key];
      if (!s.code && !list.length) continue;
      L.push(thin, `${s.label.toUpperCase()} — INTERSEÇÕES (${list.length})`, thin);
      if (!list.length) L.push(`Nenhum polígono da ${s.label} intersectou os títulos analisados.`);
      list.forEach((item, i) => {
        const info = serieInfo(s, item.props);
        L.push(`[${i + 1}] ${info.title}`);
        for (const line of info.lines) L.push(`    ${line}`);
        L.push(...wrapItems(`Títulos intersectados (${item.hits.length}): `, item.hits.map(procLabel)));
        L.push("");
      });
      L.push("");
    }

    // Observações e contato final
    L.push(thin, "OBSERVAÇÕES", thin,
      "- A interseção espacial indica contato/interseção geométrica, não necessariamente",
      "  área de sobreposição economicamente relevante.",
      "- Fontes: ANM (SIGMINE) e SGB (Plangeo e Banco de Dados Aero), consultadas ao vivo.",
      "- Protótipo experimental.",
      "");
    contactBlock(L);
    L.push(bar);
    return L.join("\n");
  }

  function downloadReport() {
    if (!lastResult) return;
    const base = lastResult.mode === "holder" ? lastResult.holder : procLabel(lastResult.titles[0]);
    const slug = normalize(base).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "titulo";
    const stamp = new Date().toISOString().slice(0, 10);
    // BOM + CRLF para abrir corretamente (acentos) no Bloco de Notas do Windows
    const text = "\ufeff" + buildReport().replace(/\n/g, "\r\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `relatorio_plangeo_${slug}_${stamp}.txt`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------------------------------------------------------------
   * Eventos e inicialização
   * ------------------------------------------------------------- */
  holderButton.addEventListener("click", showHolderTitles);
  reportButton.addEventListener("click", downloadReport);
  updateReportButton();
  $("searchButton").addEventListener("click", searchTitles);
  $("searchInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") searchTitles();
  });
  $("searchType").addEventListener("change", () => {
    const placeholders = {
      processo: "Ex.: 2275/1935 ou 002.275/1935",
      titular: "Ex.: VALE, CSN, CBA",
      substancia: "Ex.: FERRO, OURO, COBRE"
    };
    $("searchInput").placeholder = placeholders[$("searchType").value];
  });

  setupLayerPanel();

  map.on("load", async () => {
    initLayers();
    applyVisibility();
    await loadAllData();
  });
})();
