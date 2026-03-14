const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const API_BASE = 'https://v3.football.api-sports.io';

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'API-Football Proxy activo' });
});

// Proxy universal — reenvía cualquier ruta a API-Football
app.get('/api/*', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({ error: 'API_FOOTBALL_KEY no configurada en variables de entorno' });
  }

  // Construir la ruta destino: /api/status → /status
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
