// Carrega as variáveis de ambiente do arquivo .env
const dotenvResult = require('dotenv').config();

if (dotenvResult.error) {
  console.warn('[AVISO] Erro ao carregar o arquivo .env:', dotenvResult.error.message);
} else {
  console.log('[INFO] Arquivo .env carregado com sucesso.');
}
console.log('[DEBUG] Status das Chaves:');
console.log('- GOOGLE_API_KEY:', process.env.GOOGLE_API_KEY ? 'OK (Carregada)' : 'FALTANDO');
console.log('- SEARCH_ENGINE_ID:', process.env.SEARCH_ENGINE_ID ? 'OK (Carregada)' : 'FALTANDO');

// --- TRATAMENTO DE ERROS GLOBAIS ---
// Captura erros que poderiam derrubar o servidor (causando 502)
process.on('uncaughtException', (err) => {
  console.error('ERRO CRÍTICO (uncaughtException):', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('ERRO CRÍTICO (unhandledRejection):', reason);
});

const express = require('express');
const cheerio = require('cheerio');
const cors = require('cors');
const fetch = require('cross-fetch'); // Usaremos cross-fetch para requisições mais leves
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

const app = express();
// Usar a porta fornecida pelo ambiente ou 3001 como padrão
const PORT = process.env.PORT || 3001;

// Habilita o CORS para permitir requisições do seu frontend
app.use(cors());
app.options('*', cors()); // Garante que requisições OPTIONS (preflight) sejam tratadas corretamente
// Habilita o parsing de JSON no corpo das requisições (Necessário para POST/PUT)
app.use(express.json());

// Rota de verificação para confirmar se o deploy funcionou
app.get('/', (req, res) => {
  res.json({ message: 'API Online', version: '1.2.0' });
});

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

// Inicializa as tabelas do banco de dados
const initDB = async () => {
  try {
    // 1. Cria o banco de dados se não existir
    const tempConnection = await mysql.createConnection(dbConfig);
    await tempConnection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await tempConnection.end();

    const connection = await pool.getConnection();
    try {
      // Tabela de Usuários
      await connection.query(`
        CREATE TABLE IF NOT EXISTS users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(255) NOT NULL UNIQUE,
          password VARCHAR(255) NOT NULL
        )
      `);
      // Tabela de Favoritos
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
      // Tabela de Cache de Cifras
      await connection.query(`
        CREATE TABLE IF NOT EXISTS cifra_cache (
          url VARCHAR(500) PRIMARY KEY,
          data JSON NOT NULL,
          timestamp BIGINT NOT NULL
        )
      `);
      console.log('Banco de dados MySQL inicializado e tabelas verificadas.');
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Erro ao conectar ou inicializar o banco de dados:', error);
  }
};

initDB();

const JWT_SECRET = process.env.JWT_SECRET || 'chave_secreta_padrao_segura';

// Middleware para verificar o Token JWT
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Formato: "Bearer TOKEN"

  if (!token) return res.status(401).json({ error: 'Acesso negado. Token não fornecido.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido ou expirado.' });
    req.user = user; // Adiciona os dados do usuário à requisição
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
    // Verifica se usuário já existe
    const [existingUsers] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    if (existingUsers.length > 0) {
      return res.status(409).json({ error: 'Email já cadastrado.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Insere novo usuário
    await pool.query('INSERT INTO users (email, password) VALUES (?, ?)', [email, hashedPassword]);

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
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);
    const user = rows[0];

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ error: 'Erro interno ao realizar login.' });
  }
});

// 3. Listar Favoritos (Rota Protegida)
app.get('/api/favorites', authenticateToken, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM favorites WHERE user_id = ? ORDER BY added_at DESC', [req.user.id]);
    res.json(rows);
  } catch (error) {
    console.error('Erro ao buscar favoritos:', error);
    res.status(500).json({ error: 'Erro ao buscar favoritos.' });
  }
});

// 4. Adicionar Favorito (Rota Protegida)
app.post('/api/favorites', authenticateToken, async (req, res) => {
  let { song, artist, url, title } = req.body;
  
  // Compatibilidade: Se vier da busca, pode ter 'title' em vez de 'song' e 'artist'
  if (!song && title) {
    song = title;
    artist = artist || 'Desconhecido';
  }
  
  if (!song || !url) {
    return res.status(400).json({ error: 'Dados da cifra (nome ou url) incompletos.' });
  }

  try {
    // Verifica duplicatas
    const [existing] = await pool.query('SELECT * FROM favorites WHERE user_id = ? AND url = ?', [req.user.id, url]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Esta cifra já está nos favoritos.' });
    }

    // Insere
    const [result] = await pool.query(
      'INSERT INTO favorites (user_id, song, artist, url) VALUES (?, ?, ?, ?)',
      [req.user.id, song, artist, url]
    );

    const newFavorite = { id: result.insertId, song, artist, url, added_at: new Date() };
    res.status(201).json({ message: 'Favorito adicionado', favorite: newFavorite });
  } catch (error) {
    console.error('Erro ao adicionar favorito:', error);
    res.status(500).json({ error: 'Erro ao salvar favorito.' });
  }
});

// 5. Remover Favorito (Rota Protegida)
app.delete('/api/favorites', authenticateToken, async (req, res) => {
  const { url } = req.body;
  
  if (!url) return res.status(400).json({ error: 'URL da cifra é obrigatória.' });

  try {
    await pool.query('DELETE FROM favorites WHERE user_id = ? AND url = ?', [req.user.id, url]);
    res.json({ message: 'Favorito removido' });
  } catch (error) {
    console.error('Erro ao remover favorito:', error);
    res.status(500).json({ error: 'Erro ao remover favorito.' });
  }
});

const CACHE_DURATION_MS = 1000 * 60 * 60; // 1 hora

app.get('/api/search', async (req, res) => {
  const { q: query } = req.query;

  if (!query) {
    return res.status(400).json({ error: 'O parâmetro de busca "q" é obrigatório.' });
  }

  try {
    // --- MUDANÇA: Usar a API do Google Custom Search ---
    const apiKey = process.env.GOOGLE_API_KEY;
    const searchEngineId = process.env.SEARCH_ENGINE_ID;

    if (!apiKey || !searchEngineId) {
      console.error('GOOGLE_API_KEY ou SEARCH_ENGINE_ID não configurados.');
      return res.status(500).json({ error: 'Configuração da API do Google ausente no servidor.' });
    }

    const apiUrl = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${searchEngineId}&q=${encodeURIComponent(query)}&num=10`;
    console.log(`[DEBUG] Buscando na API do Google: ${apiUrl}`);

    const response = await fetch(apiUrl);

    if (!response.ok) {
      const errorData = await response.json();
      console.error('[ERROR] Erro da API do Google:', errorData);
      throw new Error(`Erro na API do Google: ${response.statusText}`);
    }

    const data = await response.json();

    // Mapeia os resultados da API do Google
    let results = (data.items || [])
      .filter(item => !item.link.includes('/letra/')) // Filtra letras, queremos cifras
      .map(item => {
        // Limpa o título
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

    // Remove duplicatas (ex: simplificada vs normal)
    const uniqueResults = new Map();
    results.forEach(item => {
      const baseUrl = item.url.replace('/simplificada.html', '/');
      if (!uniqueResults.has(baseUrl)) {
        uniqueResults.set(baseUrl, item);
      }
    });
    
    res.json(Array.from(uniqueResults.values()));

  } catch (error) {
    console.error('Erro ao fazer a busca:', error);
    // BLINDAGEM: Se der erro, retorna lista vazia para não quebrar o frontend com erro 500
    if (!res.headersSent) res.json([{
      title: `[DEBUG] Erro Interno: ${error.message}`,
      url: '#'
    }]);
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
  try {
    const [rows] = await pool.query('SELECT * FROM cifra_cache WHERE url = ?', [url]);
    if (rows.length > 0) {
      const cachedEntry = rows[0];
      if (Date.now() - cachedEntry.timestamp < CACHE_DURATION_MS) {
        console.log(`[CACHE HIT] Servindo do banco de dados para: ${url}`);
        return res.json(cachedEntry.data); // mysql2 converte JSON automaticamente
      }
    }
  } catch (err) {
    console.error('Erro ao consultar cache:', err);
    // Continua para o scraping se o cache falhar
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
      try {
        // Salva ou atualiza no banco (Upsert)
        await pool.query(
          'INSERT INTO cifra_cache (url, data, timestamp) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = ?, timestamp = ?',
          [url, JSON.stringify(responseData), Date.now(), JSON.stringify(responseData), Date.now()]
        );
        console.log(`[CACHE SAVE] Salvo no banco para: ${url}`);
      } catch (err) {
        console.error('Erro ao salvar no cache:', err);
      }
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