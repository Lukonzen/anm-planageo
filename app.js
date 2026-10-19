(() => {
  "use strict";

  const ANM_QUERY = "https://geo.anm.gov.br/arcgis/rest/services/SIGMINE/dados_anm/FeatureServer/0/query";
  const SGB_QUERY = "https://geoportal.sgb.gov.br/server/rest/services/Hosted/Aerogeofisica/FeatureServer/1/query";
  const ANM_FIELDS = "PROCESSO,NUMERO,ANO,FASE,NOME,SUBS,USO,AREA_HA,UF,ULT_EVENTO,ID,OBJECTID,DSProcesso";
  const SGB_FIELDS = "objectid,num_projeto,projeto,metodo,ano_prev,processo_sei,direcao_lv,espacamento_lv,espacamento_lc,km_estimado,custo_estimado,area,objetivo,objeto_geologico,bioma,tempo_estimado,observacao,status,bloco";

  const $ = (id) => document.getElementById(id);
  const statusEl = $("searchStatus");
  const resultsEl = $("results");
  const summaryEl = $("resultsSummary");
  const detailsEl = $("projectDetails");
  const projectSummaryEl = $("projectSummary");
  const searchButton = $("searchButton");

  let planageoFeatures = [];
  let selectedResultButton = null;
  let selectedProjectIds = new Set();
  let activeTitleFeature = null;

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

  async function loadPlanageo() {
    const idData = await postQuery(SGB_QUERY, {
      where: "1=1",
      returnIdsOnly: "true",
      f: "json"
    });
    const ids = idData.objectIds || [];
    if (!ids.length) {
      planageoFeatures = [];
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
      projectSummaryEl.textContent = `Carregando projetos Planageo: ${all.length} de ${ids.length}…`;
    }
    planageoFeatures = all;
    const fc = { type: "FeatureCollection", features: planageoFeatures };
    map.addSource("planageo", { type: "geojson", data: fc });
    map.addLayer({
      id: "planageo-fill",
      type: "fill",
      source: "planageo",
      paint: {
        "fill-color": [
          "case",
          ["in", ["to-string", ["get", "objectid"]], ["literal", []]],
          "#f59e0b",
          "#4b9ce2"
        ],
        "fill-opacity": 0.25
      }
    });
    map.addLayer({
      id: "planageo-line",
      type: "line",
      source: "planageo",
      paint: { "line-color": "#1e6091", "line-width": 1.3 }
    });
    map.addSource("selected-projects", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });
    map.addLayer({
      id: "selected-projects-fill",
      type: "fill",
      source: "selected-projects",
      paint: { "fill-color": "#f59e0b", "fill-opacity": 0.5 }
    });
    map.addLayer({
      id: "selected-projects-line",
      type: "line",
      source: "selected-projects",
      paint: { "line-color": "#b86b00", "line-width": 3 }
    });
    map.addSource("selected-title", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] }
    });
    map.addLayer({
      id: "selected-title-fill",
      type: "fill",
      source: "selected-title",
      paint: { "fill-color": "#ef4444", "fill-opacity": 0.14 }
    });
    map.addLayer({
      id: "selected-title-line",
      type: "line",
      source: "selected-title",
      paint: { "line-color": "#d72e2e", "line-width": 2.5 }
    });

    map.on("click", "planageo-fill", (event) => {
      const feature = event.features && event.features[0];
      if (feature) showProjectDetails(feature.properties, []);
    });
    map.on("mouseenter", "planageo-fill", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "planageo-fill", () => { map.getCanvas().style.cursor = ""; });

    projectSummaryEl.textContent = `${planageoFeatures.length} polígonos/projetos carregados do serviço do SGB.`;
    setStatus("Camada Planageo carregada. Busque um título ANM.");
  }

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
        : "Busca concluída. Selecione um título para cruzá-lo com os projetos Planageo.");
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

  async function selectTitle(attrs, button) {
    if (selectedResultButton) selectedResultButton.classList.remove("active");
    selectedResultButton = button;
    button.classList.add("active");
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
      selectedProjectIds = new Set(matches.map(p => String(p.objectid)));
      const selectedFeatures = planageoFeatures.filter(f => selectedProjectIds.has(String(f.properties?.objectid)));
      map.getSource("selected-projects").setData({ type: "FeatureCollection", features: selectedFeatures });
      showProjectDetails(attrs, matches);
      fitGeometry(titleFeature.geometry);
      setStatus(`Título selecionado. ${matches.length} projeto(s) Planageo com interseção geométrica.`);
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

  function showProjectDetails(properties, matches) {
    detailsEl.replaceChildren();
    const isTitle = properties && (properties.PROCESSO || properties.DSProcesso || properties.OBJECTID != null);
    if (isTitle) {
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
      detailsEl.append(textEl("p", `Projetos Planageo intersectados: ${matches.length}`, "results-summary"));
      if (!matches.length) {
        detailsEl.append(textEl("p", "Nenhum polígono Planageo intersectou este título.", "muted"));
      }
      for (const p of matches) detailsEl.append(projectCard(p));
    } else {
      detailsEl.append(projectCard(properties));
    }
  }

  function projectCard(p) {
    const card = document.createElement("div");
    card.className = "project-link";
    const name = p.projeto || `Projeto ${p.num_projeto || p.objectid || ""}`;
    card.append(textEl("strong", `${p.num_projeto || ""} ${name}`.trim()));
    card.append(textEl("p", `Bloco: ${p.bloco || "—"} · Previsão: ${p.ano_prev || "não informada"}`));
    ;card.append(textEl("p", `Métodos: ${p.metodo || "não informado"}`));
    if (p.area != null) card.append(textEl("p", `Área informada pelo SGB: ${formatArea(p.area)} km²`));
    if (p.km_estimado != null) card.append(textEl("p", `Extensão estimada: ${Number(p.km_estimado).toLocaleString("pt-BR", { maximumFractionDigits: 0 })} km`));
    if (p.status) card.append(textEl("p", `Status: ${p.status}`));
    return card;
  }

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

  map.on("load", async () => {
    try {
      await loadPlanageo();
    } catch (error) {
      projectSummaryEl.textContent = "Não foi possível carregar os polígonos Planageo.";
      setStatus(`Falha ao carregar SGB: ${error.message}. Verifique a conexão e possíveis restrições de CORS.`, true);
    }
  });
})();
