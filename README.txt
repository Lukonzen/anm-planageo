PLANAGEO × TÍTULOS ANM — PROTÓTIPO 0.1

O que esta versão faz
- Carrega os polígonos da camada pública Planageo/SGB.
- Pesquisa títulos na camada pública da ANM por processo, titular ou substância.
- Ao selecionar um título, consulta a geometria do título e pede ao SGB os projetos com relação espacial intersects.
- Destaca no mapa o título e os projetos Planageo retornados.

IMPORTANTE
- A relação espacial "intersects" também pode contar contato apenas na borda. Não significa que exista sobreposição de área significativa.
- A busca por titular/substância é parcial (contém o texto), não fuzzy matching verdadeiro.
- A lista de títulos é limitada aos primeiros 100 resultados; refine a busca se houver mais.
- O protótipo depende dos serviços públicos da ANM/SGB, de acesso à internet e das políticas de CORS desses serviços.
- O mapa base usa os tiles padrão do OpenStreetMap. Para uso público em escala, revisar a política de tiles e adotar um provedor apropriado.
- Os dados são consultados ao vivo; este protótipo não baixa nem armazena a base completa da ANM.

COMO EXECUTAR NO LINUX
1. Extraia o ZIP para uma pasta, por exemplo ~/planageo_mvp
2. Abra um terminal nessa pasta.
3. Execute:
   python3 -m http.server 8000
4. Abra no navegador:
   http://localhost:8000

Não abra index.html com file://, pois os navegadores podem bloquear requisições de rede nesse modo.

FONTES DOS DADOS
SGB Planageo:
https://geoportal.sgb.gov.br/server/rest/services/Hosted/Aerogeofisica/FeatureServer/1
ANM SIGMINE:
https://geo.anm.gov.br/arcgis/rest/services/SIGMINE/dados_anm/FeatureServer/0
