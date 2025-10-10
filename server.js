// Carrega as variáveis de ambiente do arquivo .env
require('dotenv').config();

const express = require('express');
const cheerio = require('cheerio');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3001; // Mantido para desenvolvimento local

// Habilita o CORS para permitir requisições do seu frontend
app.use(cors());

app.get('/api/search', async (req, res) => {
  const { q: query } = req.query;

  if (!query) {
    return res.status(400).json({ error: 'O parâmetro de busca "q" é obrigatório.' });
  }

  let browser;
  let page;
  try {
    const searchUrl = `https://www.cifraclub.com.br/?q=${encodeURIComponent(query)}`;
    console.log(`[DEBUG] Buscando na URL: ${searchUrl}`);

    console.log('[PUPPETEER] Iniciando uma nova instância do navegador...');
    browser = await puppeteer.launch({
      headless: true, // Garante que rode em modo headless no servidor
      args: [
        '--no-sandbox', // Essencial para rodar em ambientes Linux/Docker
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // Evita problemas de memória compartilhada
        '--disable-gpu' // Desnecessário em modo headless
      ]
    });

    console.log('[PUPPETEER] Abrindo nova página...');
    page = await browser.newPage();
    // Otimização: Bloqueia o carregamento de recursos desnecessários (imagens, css, fontes)
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

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
    if (browser) {
      await browser.close();
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

  let browser;
  let page;
  try {
    console.log(`[DEBUG] Raspando conteúdo da URL: ${url}`);

    console.log('[PUPPETEER] Iniciando uma nova instância do navegador...');
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });

    console.log('[PUPPETEER] Abrindo nova página...');
    page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

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
    if (browser) {
      await browser.close();
    }
  }
});

// Se não estiver no ambiente da Vercel, inicie o servidor localmente
if (process.env.VERCEL_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Servidor da API rodando na porta ${PORT}`);
  });
}

module.exports = app; // Exporta o app para a Vercel