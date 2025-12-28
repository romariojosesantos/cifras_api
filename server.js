// Carrega as variáveis de ambiente do arquivo .env
require('dotenv').config();

const express = require('express');
const cheerio = require('cheerio');
const cors = require('cors');
const fetch = require('cross-fetch'); // Usaremos cross-fetch para requisições mais leves

const app = express();
// Usar a porta fornecida pelo ambiente ou 3001 como padrão
const PORT = process.env.PORT || 3001;

// Habilita o CORS para permitir requisições do seu frontend
app.use(cors());

// Rota de verificação para confirmar se o deploy funcionou
app.get('/', (req, res) => {
  res.json({ message: 'API Online', version: '1.1.0' });
});

// --- Implementação do Cache em Memória ---
const cache = new Map();
const CACHE_DURATION_MS = 1000 * 60 * 60; // 1 hora

app.get('/api/search', async (req, res) => {
  const { q: query } = req.query;

  if (!query) {
    return res.status(400).json({ error: 'O parâmetro de busca "q" é obrigatório.' });
  }

  try {
    // --- MUDANÇA: Usar a API do Google Custom Search em vez de raspar o HTML ---
    const apiKey = process.env.GOOGLE_API_KEY;
    const searchEngineId = process.env.SEARCH_ENGINE_ID;

    if (!apiKey || !searchEngineId) {
      throw new Error('As variáveis de ambiente GOOGLE_API_KEY e SEARCH_ENGINE_ID não foram configuradas.');
    }

    const apiUrl = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${searchEngineId}&q=${encodeURIComponent(query)}&num=10`;
    console.log(`[DEBUG] Buscando na API do Google: ${apiUrl}`);

    const apiResponse = await fetch(apiUrl); // Renomeado para evitar conflito
    if (!apiResponse.ok) {
      const errorData = await apiResponse.json();
      console.error('[ERROR] Erro da API do Google:', errorData);
      throw new Error(`Erro ao buscar na API do Google: ${apiResponse.statusText}`);
    }
    
    const data = await apiResponse.json();
    
    // Mapeia os resultados da API para o formato que nosso frontend espera
    let results = (data.items || [])
      // 1. Filtra URLs que são apenas de letras, pois não têm cifras.
      .filter(item => !item.link.includes('/letra/'))
      .map(item => {
        // 2. Limpa o título, removendo sufixos indesejados.
        const cleanedTitle = item.title
          .replace(/ - Cifra Club$/, '')
          .replace(/\(letra da música\)/, '')
          .replace(/ - (versão simplificada)/, '')
          .trim();
        return {
          title: cleanedTitle,
          url: item.link
        };
      });

    // 3. Remove duplicatas, priorizando a cifra normal sobre a simplificada.
    // Cria uma URL base (sem 'simplificada.html') para cada item e mantém apenas a primeira ocorrência.
    const uniqueResults = new Map();
    results.forEach(item => {
      const baseUrl = item.url.replace('/simplificada.html', '/');
      if (!uniqueResults.has(baseUrl)) {
        uniqueResults.set(baseUrl, item);
      }
    });
    results = Array.from(uniqueResults.values());
    
    if (results.length === 0) {
      console.log('[DEBUG] A API do Google não retornou resultados.');
    }

    res.json(results);

  } catch (error) {
    console.error('Erro ao fazer a busca:', error);
    res.status(500).json({ error: 'Ocorreu um erro ao buscar os resultados.', details: error.message });
  }
});

app.get('/api/cifra', async (req, res) => {
  console.log(`[DEBUG] Recebida requisição em /api/cifra: ${req.query.url}`);
  let { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'O parâmetro "url" é obrigatório.' });
  }

  // CORREÇÃO: Limpa a URL removendo aspas e espaços em branco extras.
  // Isso torna a API mais robusta a entradas mal formatadas.
  url = url.trim().replace(/^"|"$/g, '');

  // Validação simples para garantir que estamos acessando o Cifra Club
  if (!url.includes('cifraclub.com.br')) {
    return res.status(400).json({ error: 'A URL fornecida não é do Cifra Club.' });
  }

  // --- VERIFICAÇÃO DO CACHE ---
  const cachedEntry = cache.get(url);
  if (cachedEntry && (Date.now() - cachedEntry.timestamp < CACHE_DURATION_MS)) {
    console.log(`[CACHE] Servindo do cache para a URL: ${url}`);
    return res.json(cachedEntry.data);
  }

  try {
    console.log(`[DEBUG] Raspando conteúdo da URL: ${url}`);

    // ATUALIZAÇÃO CRÍTICA: O Cifra Club bloqueia requisições sem um User-Agent de navegador.
    // Para simular um navegador real e evitar o bloqueio, adicionamos cabeçalhos à requisição.
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
      }
    });

    if (!response.ok) {
      throw new Error(`Erro ao carregar a página da cifra: ${response.statusText}`);
    }
    const html = await response.text();
    const $ = cheerio.load(html);

    // --- LÓGICA DEFINITIVA PARA EXTRAIR O videoId (LEVE E EFICIENTE) ---
    // O Cifra Club (Next.js) embute os dados da página, incluindo o videoId,
    // em uma tag <script id="__NEXT_DATA__"> como um JSON.
    let videoId = null;
    const nextDataScript = $('#__NEXT_DATA__').html();

    if (nextDataScript) {
      try {
        const nextData = JSON.parse(nextDataScript);
        // O videoId está aninhado dentro da estrutura de props da página.
        // --- LÓGICA ROBUSTA ---
        // O Cifra Club tem variações na estrutura. O vídeo pode estar em `pageProps.video`
        // ou aninhado em `pageProps.songData.video`. Este código tenta ambos os caminhos.
        const pageProps = nextData?.props?.pageProps;
        videoId = pageProps?.video?.youtube_id || pageProps?.songData?.video?.youtube_id || null;

      } catch (e) {
        console.error('Erro ao fazer parse do JSON do __NEXT_DATA__:', e);
      }
    }

    // 1. Tenta encontrar o conteúdo da cifra (tag <pre>)
    // --- CONVERSÃO PARA CHORDPRO ---
    // Substitui as tags <b>Acorde</b> por [Acorde] e extrai o texto puro.
    const pre = $('pre');
    if (pre.length) {
      pre.find('b').each((_, el) => {
        $(el).replaceWith(`[${$(el).text()}]`);
      });
    }
    const cifraContent = pre.length ? pre.text() : null;

    let responseData = null;

    if (cifraContent) {
      // Se encontrou a cifra, retorna o conteúdo
      const artist = $('h2.t3 a.t1').text();
      const song = $('h1.t1').text();
      

      responseData = {
        type: 'cifra',
        artist: artist,
        song: song,
        content: cifraContent,
        videoId: videoId // Adiciona o ID do vídeo à resposta
      };
    } else {
      // 2. Se não encontrou, tenta encontrar uma lista de músicas (página de artista)
      const songsList = [];
      $('ol.list-links.art_musics.top-songs a.al-link').each((index, element) => {
        songsList.push({
          title: $(element).text(),
          url: `https://www.cifraclub.com.br${$(element).attr('href')}`
        });
      });

      if (songsList.length > 0) {
        const artistName = $('h1.t1').text();
        responseData = { type: 'artist', artist: artistName, songs: songsList };
      } else {
        // 3. Se não encontrou nem cifra nem lista de músicas, retorna o erro
        res.status(404).json({ error: 'Nenhum conteúdo de cifra ou lista de músicas foi encontrado na página.' });
        return; // Encerra a execução para não cachear o erro
      }
    }

    // --- ARMAZENAMENTO NO CACHE ---
    if (responseData) {
      cache.set(url, { data: responseData, timestamp: Date.now() });
      console.log(`[CACHE] Armazenado no cache para a URL: ${url}`);
      res.json(responseData);
    }

  } catch (error) {
    console.error('Erro ao raspar a página da cifra:', error);
    res.status(500).json({ error: 'Ocorreu um erro ao obter o conteúdo da cifra.', details: error.message });
  }
});

// Inicia o servidor.
// Em ambientes como Vercel, a chamada `listen` é ignorada e o `module.exports` é usado.
// Em outros ambientes (como Easypanel, Heroku, ou local), o servidor iniciará e ouvirá na porta especificada.
app.listen(PORT, () => {
  console.log(`Servidor da API rodando na porta ${PORT}`);
});

module.exports = app; // Exporta o app para a Vercel