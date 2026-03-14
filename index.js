const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 8080;
const API_BASE = 'https://v3.football.api-sports.io';

app.use(cors());
app.use(express.json());

console.log('Servidor iniciando...');
console.log('API_FOOTBALL_KEY presente:', !!process.env.API_FOOTBALL_KEY);
console.log('API_FOOTBALL_KEY longitud:', (process.env.API_FOOTBALL_KEY || '').length);

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'API-Football Proxy activo',
    key_configured: !!process.env.API_FOOTBALL_KEY
  });
});

app.get('/api/*', async (req, res) => {
  const API_KEY = process.env.API_FOOTBALL_KEY;

  if (!API_KEY) {
    return res.status(500).json({ 
      error: 'API_FOOTBALL_KEY no configurada',
      available_env: Object.keys(process.env).filter(k => !k.includes('npm') && !k.includes('PATH') && !k.includes('HOME'))
    });
  }

  const path = req.path.replace('/api', '');
  const query = new URLSearchParams(req.query).toString();
  const url = `${API_BASE}${path}${query ? '?' + query : ''}`;

  try {
    const response = await fetch(url, {
      headers: {
        'x-apisports-key': API_KEY,
        'Accept': 'application/json',
      },
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Error al conectar con API-Football', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Proxy corriendo en puerto ${PORT}`);
});
