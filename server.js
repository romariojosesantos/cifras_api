const express = require('express');
const cheerio = require('cheerio');
const cors = require('cors');
const puppeteer = require('puppeteer-core');

const app = express();
const PORT = process.env.PORT || 3001; // Mantido para desenvolvimento local

// --- Otimização: Gerenciamento da instância do Puppeteer ---
// Variável para armazenar a instância global do navegador
let browserInstance;

// Função para iniciar o Puppeteer e retornar a instância do navegador
async function startBrowser() {
  if (!browserInstance) {
    console.log('[BROWSERLESS] Conectando a uma instância remota...');

    const apiKey = process.env.BROWSERLESS_API_KEY;

    if (!apiKey) {
      throw new Error('A variável de ambiente BROWSERLESS_API_KEY não está definida.');
    }

    // Conecta-se a uma instância do Browserless.io
    // A chave de API é passada via variável de ambiente.
    browserInstance = await puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${apiKey}`,
    });
  }
  return browserInstance;
}

// Função para fechar o navegador de forma graciosa
async function closeBrowser() {
  if (browserInstance) {
    console.log('[PUPPETEER] Fechando a instância do navegador...');
    await browserInstance.close();
    browserInstance = null; // Limpa a instância
  }
}

// Habilita o CORS para permitir requisições do seu frontend
app.use(cors());

app.get('/api/search', async (req, res) => {
  const { q: query } = req.query;

  if (!query) {
    return res.status(400).json({ error: 'O parâmetro de busca "q" é obrigatório.' });
  }

  let page;
  try {
    const searchUrl = `https://www.cifraclub.com.br/?q=${encodeURIComponent(query)}`;
    console.log(`[DEBUG] Buscando na URL: ${searchUrl}`);

    // Reutiliza a instância do navegador e cria apenas uma nova página
    const browser = await startBrowser();
    page = await browser.newPage();

    // Navega para a URL e espera a página carregar completamente
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
    console.log('[DEBUG] Página carregada no Puppeteer.');

    try { 
      // Espera o seletor dos resultados aparecer na página (até 10 segundos)
      await page.waitForSelector('a.gs-title', { timeout: 10000 });
      console.log('[DEBUG] Seletor de resultados encontrado.');
    } catch (timeoutError) {
      // Se o seletor não for encontrado, significa que não há resultados.
      console.log('[DEBUG] Nenhum resultado encontrado (timeout). Retornando lista vazia.');
      return res.json([]);
    }

    // Pega o conteúdo HTML da página renderizada
    const data = await page.content();

    // Carrega o HTML renderizado no Cheerio
    const $ = cheerio.load(data);

    const results = [];
    // O seletor 'a.gs-title' encontra os links de resultado da busca do Google.
    $('a.gs-title').each((index, element) => {
      // Para o loop se já tivermos 5 resultados
      if (results.length >= 5) {
        return false; // Interrompe o loop do .each()
      }

      console.log(`[DEBUG] Encontrado elemento ${index + 1}`);
      const linkElement = $(element);
      
      // O URL real está no atributo 'data-ctorig'
      const url = linkElement.attr('data-ctorig');
      console.log(`  [DEBUG] URL: ${url}`);
      
      // Pega todo o texto dentro do link <a> e limpa
      const fullTitle = linkElement
        .text()
        .replace(/Cifra Club/gi, '') // Remove a expressão "Cifra Club"
        .trim();

      // Adiciona o resultado apenas se tivermos as informações essenciais
      // Verificamos se o URL é válido e pertence ao Cifra Club
      if (url && url.includes('cifraclub.com.br') && fullTitle) {
        results.push({
          title: fullTitle,
          url: url
        });
      }
    });

    res.json(results);

  } catch (error) {
    console.error('Erro ao fazer o scraping:', error);
    res.status(500).json({ error: 'Ocorreu um erro ao buscar as cifras.' });
  } finally {
    // Garante que a PÁGINA seja fechada após cada requisição
    if (page) {
      await page.close();
    }
  }
});

app.get('/api/scrape', async (req, res) => {
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

  let page;
  try {
    console.log(`[DEBUG] Raspando conteúdo da URL: ${url}`);

    // Reutiliza a instância do navegador
    const browser = await startBrowser();
    page = await browser.newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    console.log('[DEBUG] Página da cifra carregada.');

    const html = await page.content();
    const $ = cheerio.load(html);

    // 1. Tenta encontrar o conteúdo da cifra
    const cifraContent = $('pre').html();

    if (cifraContent) {
      // Se encontrou a cifra, retorna o conteúdo
      const artist = $('h2.t3 a.t1').text();
      const song = $('h1.t1').text();

      res.json({
        type: 'cifra',
        artist: artist,
        song: song,
        content: cifraContent
      });
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
        res.json({ type: 'artist', artist: artistName, songs: songsList });
      } else {
        // 3. Se não encontrou nem cifra nem lista de músicas, retorna o erro
        res.status(404).json({ error: 'Nenhum conteúdo de cifra ou lista de músicas foi encontrado na página.' });
      }
    }

  } catch (error) {
    console.error('Erro ao raspar a página da cifra:', error);
    res.status(500).json({ error: 'Ocorreu um erro ao obter o conteúdo da cifra.' });
  } finally {
    // Fecha a página após a requisição
    if (page) {
      await page.close();
    }
  }
});

// Se não estiver no ambiente da Vercel, inicie o servidor localmente
if (process.env.VERCEL_ENV !== 'production') {
  const server = app.listen(PORT, () => {
    // Não precisamos mais iniciar o navegador localmente
    console.log(`Servidor da API rodando na porta ${PORT}`);
  });

  // --- Tratamento para desligamento gracioso (local) ---
  process.on('SIGINT', async () => {
    await closeBrowser();
    server.close(() => console.log('Servidor encerrado.'));
    process.exit(0);
  });
}

module.exports = app; // Exporta o app para a Vercel