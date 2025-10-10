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

app.get('/api/search', async (req, res) => {
  const { q: query } = req.query;

  if (!query) {
    return res.status(400).json({ error: 'O parâmetro de busca "q" é obrigatório.' });
  }

  try {
    const searchUrl = `https://www.cifraclub.com.br/?q=${encodeURIComponent(query)}`;
    console.log(`[DEBUG] Buscando na URL: ${searchUrl}`);

    // Otimização: Usar fetch em vez de Puppeteer para a busca
    const response = await fetch(searchUrl);
    if (!response.ok) {
      throw new Error(`Erro ao buscar: ${response.statusText}`);
    }
    const data = await response.text();
    const $ = cheerio.load(data);

    const results = [];
    // O seletor para os resultados da busca mudou ou pode variar. Este é mais genérico.
    $('a.gsc-a-result').each((index, element) => {
      if (results.length >= 5) {
        return false;
      }

      console.log(`[DEBUG] Encontrado elemento ${index + 1}`);
      const linkElement = $(element);
      
      // O URL real está no atributo 'data-ctorig'
      const url = linkElement.attr('data-ctorig');
      const fullTitle = linkElement
        .text()
        .replace(/Cifra Club/gi, '') // Remove a expressão "Cifra Club"
        .trim();

      console.log(`  [DEBUG] Título: ${fullTitle}, URL: ${url}`);
      // Adiciona o resultado apenas se tivermos as informações essenciais
      // Verificamos se o URL é válido e pertence ao Cifra Club
      if (url && url.includes('cifraclub.com.br') && fullTitle) {
        results.push({
          title: fullTitle,
          url: url
        });
      }
    });

    if (results.length === 0) {
      console.log('[DEBUG] Nenhum resultado encontrado com o seletor. Retornando lista vazia.');
    }

    res.json(results);

  } catch (error) {
    console.error('Erro ao fazer a busca:', error);
    res.status(500).json({ error: 'Ocorreu um erro ao buscar os resultados.' });
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

  try {
    console.log(`[DEBUG] Raspando conteúdo da URL: ${url}`);

    // Otimização: Usar fetch em vez de Puppeteer para obter o conteúdo da página
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Erro ao carregar a página da cifra: ${response.statusText}`);
    }
    const html = await response.text();
    const $ = cheerio.load(html);

    // 1. Tenta encontrar o conteúdo da cifra (tag <pre>)
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
  }
});

// Inicia o servidor.
// Em ambientes como Vercel, a chamada `listen` é ignorada e o `module.exports` é usado.
// Em outros ambientes (como Easypanel, Heroku, ou local), o servidor iniciará e ouvirá na porta especificada.
app.listen(PORT, () => {
  console.log(`Servidor da API rodando na porta ${PORT}`);
});

module.exports = app; // Exporta o app para a Vercel