const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const KOMMO_SUBDOMAIN = 'tucuenta';
const ACCESS_TOKEN = 'tu_long_lived_token_o_refresh';

// Webhook endpoint
app.post('/kommo-webhook', async (req, res) => {
  try {
    const data = req.body;
    console.log('Webhook recibido:', JSON.stringify(data, null, 2));

    // Solo procesar mensajes entrantes
    if (!data.message || data.message.incoming !== true) {
      return res.sendStatus(200);
    }

    const chatId = data.message.chat_id;
    const userMessage = data.message.text?.toLowerCase() || '';

    // Lógica simple (puedes poner LLM aquí)
    let respuesta = 'No entendí, ¿puedes repetir?';
    if (userMessage.includes('hola') || userMessage.includes('buenos')) {
      respuesta = '¡Hola! ¿En qué te puedo ayudar hoy? 😊';
    } else if (userMessage.includes('cotizar') || userMessage.includes('precio')) {
      respuesta = 'Perfecto, dime qué producto te interesa y te paso precios.';
    }

    // Enviar respuesta a Kommo
    await axios.post(
      `https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/chats/messages`,
      {
        chat_id: chatId,
        text: respuesta,
        type: 'text'
      },
      {
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(200); // SIEMPRE 200 para no bloquear reintentos
  }
});

app.listen(3000, () => console.log('Escuchando en puerto 3000'));