// Carrega as variáveis de ambiente do arquivo .env
const dotenvResult = require('dotenv').config();
const fs = require('fs');
const path = require('path');

if (dotenvResult.error) {
  console.warn('[AVISO] Erro ao carregar o arquivo .env:', dotenvResult.error.message);
} else {
  console.log('[INFO] Arquivo .env carregado com sucesso.');
}
console.log('[DEBUG] Status das Chaves:');
console.log('- GOOGLE_API_KEY:', process.env.GOOGLE_API_KEY ? 'OK (Carregada)' : 'FALTANDO (Usando busca direta CifraClub)');
console.log('- SEARCH_ENGINE_ID:', process.env.SEARCH_ENGINE_ID ? 'OK (Carregada)' : 'FALTANDO (Usando busca direta CifraClub)');

// --- TRATAMENTO DE ERROS GLOBAIS ---
process.on('uncaughtException', (err) => {
  console.error('ERRO CRÍTICO (uncaughtException):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('ERRO CRÍTICO (unhandledRejection):', reason);
});

const express = require('express');
const cheerio = require('cheerio');
const cors = require('cors');
const crossFetch = require('cross-fetch');
const fetch = globalThis.fetch || crossFetch;
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

// --- ARMAZENAMENTO LOCAL (FALLBACK QUANDO MYSQL NÃO ESTÁ RODANDO) ---
const DATA_DIR = path.join(__dirname, 'data');
const LOCAL_DB_FILE = path.join(DATA_DIR, 'local_db.json');

const loadLocalDB = () => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(LOCAL_DB_FILE)) {
      return JSON.parse(fs.readFileSync(LOCAL_DB_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[LOCAL DB] Erro ao ler banco local:', err.message);
  }
  return { users: [], favorites: [], playlists: [], customCifras: [], cifraCache: {} };
};

const saveLocalDB = (db) => {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(LOCAL_DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('[LOCAL DB] Erro ao salvar banco local:', err.message);
  }
};

let localDB = loadLocalDB();
let useMySQL = false;

// --- CONFIGURAÇÃO DO BANCO DE DADOS MYSQL ---
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  port: process.env.DB_PORT || 3306,
};
const dbName = process.env.DB_NAME || 'cifras_db';

const pool = mysql.createPool({
  ...dbConfig,
  database: dbName,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

const initDB = async () => {
  try {
    const tempConnection = await mysql.createConnection(dbConfig);
    await tempConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await tempConnection.end();

    const connection = await pool.getConnection();
    try {
      await connection.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(255) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL
        )
      `);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS favorites (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          song VARCHAR(255) NOT NULL,
          artist VARCHAR(255) NOT NULL,
          url VARCHAR(255) NOT NULL,
          added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE KEY unique_fav (user_id, url)
        )
      `);
      await connection.query(`
        CREATE TABLE IF NOT EXISTS cifra_cache (
          url VARCHAR(500) PRIMARY KEY,
          data JSON NOT NULL,
          timestamp BIGINT NOT NULL
        )
      `);
      useMySQL = true;
      console.log('[INFO] Banco de dados MySQL conectado e tabelas verificadas.');
    } finally {
      connection.release();
    }
  } catch (error) {
    useMySQL = false;
    console.warn(`[AVISO] MySQL indisponível (${error.code || error.message}). Usando banco local em arquivo (data/local_db.json) automaticamente.`);
  }
};

initDB();

// Rota de verificação
app.get('/', (req, res) => {
  res.json({
    message: 'API Online',
    version: '2.0.0',
    storage: useMySQL ? 'MySQL' : 'Local JSON Fallback'
  });
});

const JWT_SECRET = process.env.JWT_SECRET || 'chave_secreta_padrao_segura';

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Acesso negado. Token não fornecido.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido ou expirado.' });
    req.user = user;
    next();
  });
};

// 1. Registrar Usuário
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email e senha são obrigatórios.' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    if (useMySQL) {
      const [existingUsers] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
      if (existingUsers.length > 0) {
        return res.status(409).json({ error: 'Email já cadastrado.' });
      }
      await pool.query('INSERT INTO users (email, password) VALUES (?, ?)', [email, hashedPassword]);
    } else {
      if (localDB.users.some(u => u.email === email)) {
        return res.status(409).json({ error: 'Email já cadastrado.' });
      }
      localDB.users.push({ id: Date.now(), email, password: hashedPassword });
      saveLocalDB(localDB);
    }
    res.status(201).json({ message: 'Usuário registrado com sucesso' });
  } catch (error) {
    console.error('Erro no registro:', error);
    res.status(500).json({ error: 'Erro interno ao registrar usuário.' });
  }
});

// 2. Login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    let user = null;
    if (useMySQL) {
      const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
      user = rows[0];
    } else {
      user = localDB.users.find(u => u.email === email);
    }

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: 'Erro interno ao realizar login.' });
  }
});

// 3. Listar Favoritos
app.get('/api/favorites', authenticateToken, async (req, res) => {
  try {
    if (useMySQL) {
      const [rows] = await pool.query('SELECT * FROM favorites WHERE user_id = ? ORDER BY added_at DESC', [req.user.id]);
      return res.json(rows);
    } else {
      const rows = localDB.favorites.filter(f => f.user_id === req.user.id);
      return res.json(rows);
    }
  } catch (error) {
    console.error('Erro ao buscar favoritos:', error);
    res.status(500).json({ error: 'Erro ao buscar favoritos.' });
  }
});

// 4. Adicionar Favorito
app.post('/api/favorites', authenticateToken, async (req, res) => {
  let { song, artist, url, title } = req.body;
  if (!song && title) {
    const parts = title.split(' - ');
    song = parts[0] || title;
    artist = artist || parts[1] || 'Desconhecido';
  }
  if (!song || !url) {
    return res.status(400).json({ error: 'Dados da cifra (nome ou url) incompletos.' });
  }

  try {
    if (useMySQL) {
      const [existing] = await pool.query('SELECT * FROM favorites WHERE user_id = ? AND url = ?', [req.user.id, url]);
      if (existing.length > 0) {
        return res.status(409).json({ error: 'Esta cifra já está nos favoritos.' });
      }
      const [result] = await pool.query(
        'INSERT INTO favorites (user_id, song, artist, url) VALUES (?, ?, ?, ?)',
        [req.user.id, song, artist, url]
      );
      const newFavorite = { id: result.insertId, song, artist, url, added_at: new Date() };
      return res.status(201).json({ message: 'Favorito adicionado', favorite: newFavorite });
    } else {
      if (localDB.favorites.some(f => f.user_id === req.user.id && f.url === url)) {
        return res.status(409).json({ error: 'Esta cifra já está nos favoritos.' });
      }
      const newFavorite = { id: Date.now(), user_id: req.user.id, song, artist, url, added_at: new Date() };
      localDB.favorites.unshift(newFavorite);
      saveLocalDB(localDB);
      return res.status(201).json({ message: 'Favorito adicionado', favorite: newFavorite });
    }
  } catch (error) {
    console.error('Erro ao adicionar favorito:', error);
    res.status(500).json({ error: 'Erro ao salvar favorito.' });
  }
});

// 5. Remover Favorito
app.delete('/api/favorites', authenticateToken, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL da cifra é obrigatória.' });

  try {
    if (useMySQL) {
      await pool.query('DELETE FROM favorites WHERE user_id = ? AND url = ?', [req.user.id, url]);
    } else {
      localDB.favorites = localDB.favorites.filter(f => !(f.user_id === req.user.id && f.url === url));
      saveLocalDB(localDB);
    }
    res.json({ message: 'Favorito removido' });
  } catch (error) {
    console.error('Erro ao remover favorito:', error);
    res.status(500).json({ error: 'Erro ao remover favorito.' });
  }
});

const CACHE_DURATION_MS = 1000 * 60 * 60 * 24; // 24 horas de cache

// --- BUSCA POR CIFRA OU POR ARTISTA ---
// Função auxiliar para buscar diretamente no índice Solr do Cifra Club
const searchCifraClubSolr = async (query) => {
  const solrUrl = `https://solr.sscdn.co/cc/h2/?q=${encodeURIComponent(query)}`;
  const response = await fetch(solrUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0'
    }
  });
  if (!response.ok) {
    throw new Error(`Erro no Solr CifraClub: ${response.status}`);
  }
  const text = await response.text();
  // O retorno é JSONP: ({ ... })
  const jsonStr = text.trim().replace(/^\(\s*/, '').replace(/\s*\)\s*;?$/, '');
  const data = JSON.parse(jsonStr);
  const docs = data?.response?.docs || [];

  return docs.map(doc => {
    // Foto/capa do artista ou do álbum
    let thumbnail = null;
    if (doc.i) {
      thumbnail = `https://akamai.sscdn.co/uploadfile/letras/fotos/${doc.i}`;
    }

    // t === "1" -> Artista, t === "2" -> Música/Cifra
    if (doc.t === '1' && doc.d) {
      return {
        type: 'artist',
        title: `${doc.a || doc.m} (Artista)`,
        artist: doc.a || doc.m,
        song: null,
        url: `https://www.cifraclub.com.br/${doc.d}/`,
        slug: doc.d,
        thumbnail
      };
    } else if (doc.t === '2' && doc.d && doc.u) {
      return {
        type: 'song',
        title: `${doc.m} - ${doc.a}`,
        song: doc.m,
        artist: doc.a,
        url: `https://www.cifraclub.com.br/${doc.d}/${doc.u}/`,
        artistUrl: `https://www.cifraclub.com.br/${doc.d}/`,
        thumbnail
      };
    }
    return null;
  }).filter(Boolean);
};

// Função auxiliar para classificar URLs do Cifra Club vindas do Google
const classifyCifraClubUrl = (url, rawTitle) => {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    // Ignorar páginas que não são cifras nem artistas
    const ignoredSegments = ['letra', 'letras', 'musico', 'blog', 'noticias', 'enviar-cifra', 'afinador', 'metronomo', 'dicionario-de-acordes'];
    if (segments.some(s => ignoredSegments.includes(s))) return null;

    const cleanedTitle = (rawTitle || '')
      .replace(/ - Cifra Club$/i, '')
      .replace(/\(letra da música\)/i, '')
      .replace(/ - (versão simplificada)/i, '')
      .trim();

    if (segments.length === 1) {
      // Página de artista: https://www.cifraclub.com.br/legiao-urbana/
      const artistName = cleanedTitle.replace(/^Cifras de /i, '').trim();
      return {
        type: 'artist',
        title: `${artistName} (Artista)`,
        artist: artistName,
        song: null,
        url: `https://www.cifraclub.com.br/${segments[0]}/`,
        slug: segments[0]
      };
    } else if (segments.length >= 2) {
      const parts = cleanedTitle.split(' - ');
      const songName = parts[0] ? parts[0].trim() : cleanedTitle;
      const artistName = parts[1] ? parts[1].trim() : segments[0].replace(/-/g, ' ');
      return {
        type: 'song',
        title: `${songName} - ${artistName}`,
        song: songName,
        artist: artistName,
        url: `https://www.cifraclub.com.br/${segments[0]}/${segments[1]}/`,
        artistUrl: `https://www.cifraclub.com.br/${segments[0]}/`
      };
    }
  } catch (e) {
    return null;
  }
  return null;
};

app.get('/api/search', async (req, res) => {
  const { q: query, type = 'all' } = req.query;

  if (!query || !query.trim()) {
    return res.status(400).json({ error: 'O parâmetro de busca "q" é obrigatório.' });
  }

  const queryLower = query.trim().toLowerCase();

  try {
    let localMatches = [];

    // --- 1. PROCURA PRIMEIRO NO BANCO DE DADOS LOCAL (OFFLINE-FIRST / SERVER-FIRST) ---
    try {
      if (useMySQL) {
        const [rows] = await pool.query(
          'SELECT url, data FROM cifra_cache'
        );
        for (const row of rows) {
          const itemData = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
          if (itemData) {
            const songMatch = itemData.song && itemData.song.toLowerCase().includes(queryLower);
            const artistMatch = itemData.artist && itemData.artist.toLowerCase().includes(queryLower);
            if (songMatch || artistMatch) {
              localMatches.push({
                type: itemData.type || 'song',
                title: itemData.song ? `${itemData.song} - ${itemData.artist}` : itemData.artist,
                song: itemData.song,
                artist: itemData.artist,
                url: itemData.url || row.url,
                thumbnail: itemData.image || itemData.thumbnail || null,
                fromCache: true
              });
            }
          }
        }
      } else if (localDB.cifraCache) {
        Object.entries(localDB.cifraCache).forEach(([cUrl, cVal]) => {
          const itemData = cVal.data;
          if (itemData) {
            const songMatch = itemData.song && itemData.song.toLowerCase().includes(queryLower);
            const artistMatch = itemData.artist && itemData.artist.toLowerCase().includes(queryLower);
            if (songMatch || artistMatch) {
              localMatches.push({
                type: itemData.type || 'song',
                title: itemData.song ? `${itemData.song} - ${itemData.artist}` : itemData.artist,
                song: itemData.song,
                artist: itemData.artist,
                url: itemData.url || cUrl,
                thumbnail: itemData.image || itemData.thumbnail || null,
                fromCache: true
              });
            }
          }
        });
      }
    } catch (cacheErr) {
      console.warn('[CACHE SEARCH] Aviso ao buscar no banco local:', cacheErr.message);
    }

    let combinedResults = [...localMatches];

    // --- 2. DEPOIS BUSCA NA REDE EXTERNA ---
    // Busca no índice Solr do Cifra Club
    try {
      const solrResults = await searchCifraClubSolr(query.trim());
      combinedResults.push(...solrResults);
    } catch (solrErr) {
      console.warn('[WARN] Falha na busca Solr CifraClub:', solrErr.message);
    }

    // Se as chaves do Google estiverem configuradas e precisarmos de mais resultados
    const apiKey = process.env.GOOGLE_API_KEY;
    const searchEngineId = process.env.SEARCH_ENGINE_ID;

    if (apiKey && searchEngineId && combinedResults.length < 5) {
      try {
        const searchQuery = type === 'artist' ? `${query} artista site:cifraclub.com.br` : `${query} site:cifraclub.com.br`;
        const apiUrl = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${searchEngineId}&q=${encodeURIComponent(searchQuery)}&num=10`;
        const response = await fetch(apiUrl);
        if (response.ok) {
          const data = await response.json();
          const googleItems = (data.items || [])
            .map(item => classifyCifraClubUrl(item.link, item.title))
            .filter(Boolean);
          combinedResults.push(...googleItems);
        }
      } catch (googleErr) {
        console.warn('[WARN] Erro complementar Google Search:', googleErr.message);
      }
    }

    // Remove duplicatas pela URL canônica
    const uniqueMap = new Map();
    combinedResults.forEach(item => {
      const normalizedUrl = item.url.replace('/simplificada.html', '/');
      if (!uniqueMap.has(normalizedUrl)) {
        uniqueMap.set(normalizedUrl, { ...item, url: normalizedUrl });
      } else {
        // Se a versão já existente não tinha thumbnail e esta tem, atualiza
        const existing = uniqueMap.get(normalizedUrl);
        if (!existing.thumbnail && item.thumbnail) {
          uniqueMap.set(normalizedUrl, { ...existing, thumbnail: item.thumbnail });
        }
      }
    });

    let finalResults = Array.from(uniqueMap.values());

    // Filtra por tipo se solicitado ('song' ou 'artist')
    if (type === 'song' || type === 'cifra') {
      finalResults = finalResults.filter(item => item.type === 'song');
    } else if (type === 'artist' || type === 'artista') {
      finalResults = finalResults.filter(item => item.type === 'artist');
    }

    res.json(finalResults);
  } catch (error) {
    console.error('Erro ao fazer a busca:', error);
    res.status(500).json({ error: 'Erro ao realizar a busca.' });
  }
});

// --- RASPAGEM DE CIFRA E PÁGINA DE ARTISTA ---
app.get('/api/cifra', async (req, res) => {
  let { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'O parâmetro "url" é obrigatório.' });
  }

  url = url.trim().replace(/^"|"$/g, '');

  if (!url.includes('cifraclub.com.br')) {
    return res.status(400).json({ error: 'A URL fornecida não é do Cifra Club.' });
  }

  // 1. Verifica cache (MySQL ou Local)
  try {
    if (useMySQL) {
      const [rows] = await pool.query('SELECT * FROM cifra_cache WHERE url = ?', [url]);
      if (rows.length > 0) {
        const cachedEntry = rows[0];
        if (Date.now() - cachedEntry.timestamp < CACHE_DURATION_MS) {
          return res.json(typeof cachedEntry.data === 'string' ? JSON.parse(cachedEntry.data) : cachedEntry.data);
        }
      }
    } else if (localDB.cifraCache && localDB.cifraCache[url]) {
      const cachedEntry = localDB.cifraCache[url];
      if (Date.now() - cachedEntry.timestamp < CACHE_DURATION_MS) {
        return res.json(cachedEntry.data);
      }
    }
  } catch (err) {
    console.warn('Aviso ao consultar cache:', err.message);
  }

  try {
    const parsedUrl = new URL(url);
    const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
    const isArtistUrl = pathSegments.length === 1;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });

    if (!response.ok && !isArtistUrl) {
      throw new Error(`Erro ao carregar a página da cifra: ${response.statusText}`);
    }

    const html = response.ok ? await response.text() : '';
    const $ = cheerio.load(html);

    // Extrai videoId (de __NEXT_DATA__ ou scripts do Next App Router)
    let videoId = null;
    const nextDataScript = $('#__NEXT_DATA__').html();
    if (nextDataScript) {
      try {
        const nextData = JSON.parse(nextDataScript);
        const pageProps = nextData?.props?.pageProps;
        videoId = pageProps?.video?.youtube_id || pageProps?.songData?.video?.youtube_id || null;
      } catch (e) {
        // ignora erro de parse
      }
    }
    if (!videoId) {
      const ytMatch = html.match(/"youtube_id"\s*:\s*"([a-zA-Z0-9_-]{11})"/) ||
                      html.match(/\\?"youtubeId\\?"\s*:\s*\\?"([a-zA-Z0-9_-]{11})\\?"/);
      if (ytMatch) videoId = ytMatch[1];
    }

    // Extrai título e artista de forma compatível com o layout novo e antigo do Cifra Club
    const ogTitle = $('meta[property="og:title"]').attr('content') || $('title').text() || '';
    const ogImage = $('meta[property="og:image"]').attr('content') || null;
    const cleanedOgTitle = ogTitle.replace(/ - Cifra Club$/i, '').trim();
    const titleParts = cleanedOgTitle.split(' - ');

    const pre = $('pre').first();
    let responseData = null;

    if (pre.length) {
      // Substitui <b>Acorde</b> por [Acorde] mantendo o texto limpo sem zero-width spaces
      pre.find('b').each((_, el) => {
        const chordText = $(el).text().trim();
        if (chordText) {
          $(el).replaceWith(`[${chordText}]`);
        }
      });

      const rawCifraContent = pre.text()
        .replace(/\u200B/g, '') // Remove zero-width spaces inseridos pelo Cifra Club
        .replace(/\r\n/g, '\n');

      const song = $('h1.t1').text().trim() || $('h1').first().text().trim() || titleParts[0] || 'Música';
      let artist = $('h2.t3 a.t1').text().trim();
      if (!artist) {
        // No layout novo do Cifra Club, o nome do artista vem no og:title ou no h2 logo após o h1
        artist = titleParts[1] ? titleParts[1].trim() : ($('h1').first().next('h2').text().trim() || 'Artista');
      }

      // Extrai o Tom Original da música indicado pelo Cifra Club
      let originalKey = $('button[data-anchor="--chord-tone"]').text().trim() ||
                        $('#cifra_tom').text().trim() ||
                        $('a.cifra_tom').text().trim() || null;

      // Tenta identificar o link do artista pela URL
      let artistUrl = null;
      try {
        const u = new URL(url);
        const segs = u.pathname.split('/').filter(Boolean);
        if (segs.length >= 1) {
          artistUrl = `https://www.cifraclub.com.br/${segs[0]}/`;
        }
      } catch (e) {}

      responseData = {
        type: 'cifra',
        artist,
        song,
        url,
        artistUrl,
        key: originalKey,
        originalKey,
        image: ogImage,
        thumbnail: ogImage,
        content: rawCifraContent,
        videoId
      };
    } else {
      // --- PÁGINA DE ARTISTA ---
      const artistSlug = pathSegments[0] || '';
      const fallbackName = artistSlug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      let artistName = $('h1.t1').text().trim() || $('h1').first().text().trim() || cleanedOgTitle.replace(/^Cifras de /i, '') || fallbackName;

      const songsMap = new Map();

      // 1. Layout novo do Cifra Club (links /artist-slug/song-slug/ com .primaryLabel)
      if (artistSlug) {
        $(`a[href^="/${artistSlug}/"]`).each((_, el) => {
          const href = $(el).attr('href');
          if (!href || href.includes('?') || href.endsWith('.html')) return;
          const segs = href.split('/').filter(Boolean);
          if (segs.length !== 2) return;
          const ignored = ['letra', 'letras', 'musico', 'discografia', 'fotos', 'videoaulas', 'contribuicoes', 'partituras'];
          if (ignored.includes(segs[1])) return;

          const fullSongUrl = `https://www.cifraclub.com.br/${segs[0]}/${segs[1]}/`;
          // Busca o nome limpo dentro do primaryLabel ou texto do link
          let songTitle = $(el).find('.primaryLabel').text().trim() ||
                          $(el).find('span').first().text().trim() ||
                          $(el).text().trim();

          // Limpa números de ranking caso tenha pego o texto bruto
          songTitle = songTitle.replace(/^\d{2}/, '').replace(/Opções$/i, '').trim();
          const songKey = $(el).find('.tertiaryLabel').text().trim() || null;

          // Ignora botões como 'Ver mais' ou links inválidos
          if (!songTitle || songTitle.toLowerCase() === 'ver mais' || songTitle.length < 2) return;

          if (!songsMap.has(fullSongUrl)) {
            songsMap.set(fullSongUrl, {
              title: songTitle,
              song: songTitle,
              artist: artistName,
              key: songKey,
              url: fullSongUrl,
              thumbnail: ogImage
            });
          }
        });
      }

      // 2. Layout antigo (fallback)
      $('ol.list-links.art_musics a.al-link, a.art_music-link').each((_, el) => {
        const href = $(el).attr('href');
        const title = $(el).text().trim();
        if (href && title && !href.endsWith('.html') && title.toLowerCase() !== 'ver mais') {
          const fullSongUrl = href.startsWith('http') ? href : `https://www.cifraclub.com.br${href}`;
          if (!songsMap.has(fullSongUrl)) {
            songsMap.set(fullSongUrl, {
              title,
              song: title,
              artist: artistName,
              url: fullSongUrl,
              thumbnail: ogImage
            });
          }
        }
      });

      // 3. Complementa com o índice Solr do artista para garantir uma lista rica de músicas
      const searchQueryForArtist = artistSlug ? artistSlug.replace(/-/g, ' ') : artistName;
      if (searchQueryForArtist) {
        try {
          const solrSongs = await searchCifraClubSolr(searchQueryForArtist);
          solrSongs.forEach(item => {
            if (item.type === 'artist' && item.slug === artistSlug && item.artist) {
              artistName = item.artist;
            }
            if (item.type === 'song' && (!artistSlug || item.url.includes(`/${artistSlug}/`))) {
              if (!songsMap.has(item.url)) {
                songsMap.set(item.url, {
                  title: item.song,
                  song: item.song,
                  artist: item.artist || artistName,
                  url: item.url,
                  thumbnail: item.thumbnail || ogImage
                });
              }
            }
          });
        } catch (e) {}
      }

      const songsList = Array.from(songsMap.values());
      if (songsList.length > 0) {
        responseData = {
          type: 'artist',
          artist: artistName,
          url,
          image: ogImage,
          thumbnail: ogImage,
          songs: songsList
        };
      } else {
        return res.status(404).json({ error: 'Nenhum conteúdo de cifra ou lista de músicas foi encontrado na página.' });
      }
    }

    // Salva no cache
    if (responseData) {
      try {
        if (useMySQL) {
          await pool.query(
            'INSERT INTO cifra_cache (url, data, timestamp) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = ?, timestamp = ?',
            [url, JSON.stringify(responseData), Date.now(), JSON.stringify(responseData), Date.now()]
          );
        } else {
          if (!localDB.cifraCache) localDB.cifraCache = {};
          localDB.cifraCache[url] = { data: responseData, timestamp: Date.now() };
          saveLocalDB(localDB);
        }
      } catch (err) {
        console.warn('Aviso ao salvar no cache:', err.message);
      }
      return res.json(responseData);
    }
  } catch (error) {
    console.error('Erro ao raspar a página da cifra:', error);
    res.status(500).json({ error: 'Ocorreu um erro ao obter o conteúdo da cifra.', details: error.message });
  }
});

// Serve o frontend React compilado caso a pasta build exista
const BUILD_PATH = path.join(__dirname, '..', 'cifraclub-search-ui', 'build');
if (fs.existsSync(BUILD_PATH)) {
  app.use(express.static(BUILD_PATH));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(BUILD_PATH, 'index.html'));
  });
  console.log(`[FRONTEND] Servindo build do React em http://0.0.0.0:${PORT}`);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor da API rodando em todas as interfaces na porta ${PORT}`);
});

module.exports = app;
