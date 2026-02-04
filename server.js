const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());

// Archivo para almacenar tokens y configuración
const CONFIG_FILE = path.join(__dirname, 'kommo_config.json');

// Configuración de Kommo
let KOMMO_CONFIG = {
  // OAuth Config
  subdomain: process.env.KOMMO_SUBDOMAIN,
  clientId: process.env.KOMMO_CLIENT_ID,
  clientSecret: process.env.KOMMO_CLIENT_SECRET,
  redirectUri: process.env.KOMMO_REDIRECT_URI,
  accessToken: process.env.KOMMO_ACCESS_TOKEN,
  refreshToken: process.env.KOMMO_REFRESH_TOKEN,
  
  // Chat Channel Config (lo recibes del soporte de Kommo)
  channelId: process.env.CHANNEL_ID,
  channelSecret: process.env.CHANNEL_SECRET,
  
  // URLs base
  baseUrl: `https://${process.env.KOMMO_SUBDOMAIN}.kommo.com`,
  chatApiUrl: 'https://amojo.kommo.com/v2/origin/custom'
};

// ==================== UTILIDADES PARA CHATS API ====================

// Generar firma HMAC-SHA1 para Chats API
function generateSignature(body, secret) {
  const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
  return crypto.createHmac('sha1', secret).update(bodyString).digest('hex');
}

// Generar MD5 del body
function generateMD5(body) {
  const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
  return crypto.createHash('md5').update(bodyString).digest('hex');
}

// Crear headers para Chats API
function createChatHeaders(body) {
  const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
  const contentMD5 = generateMD5(bodyString);
  const signature = generateSignature(bodyString, KOMMO_CONFIG.channelSecret);
  
  return {
    'Content-Type': 'application/json',
    'Content-MD5': contentMD5,
    'X-Signature': signature,
    'Date': new Date().toUTCString()
  };
}

// Verificar firma de webhook entrante
function verifyWebhookSignature(body, signature) {
  const expectedSignature = generateSignature(body, KOMMO_CONFIG.channelSecret);
  return signature === expectedSignature;
}

// Cargar configuración desde archivo
async function loadConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, 'utf8');
    const config = JSON.parse(data);
    
    if (config.accessToken) KOMMO_CONFIG.accessToken = config.accessToken;
    if (config.refreshToken) KOMMO_CONFIG.refreshToken = config.refreshToken;
    if (config.scopeId) KOMMO_CONFIG.scopeId = config.scopeId;
    
    console.log('✅ Configuración cargada desde archivo');
  } catch (error) {
    console.log('ℹ️  No se encontró configuración guardada');
  }
}

// Guardar configuración en archivo
async function saveConfig(data) {
  try {
    const existing = await fs.readFile(CONFIG_FILE, 'utf8').catch(() => '{}');
    const config = JSON.parse(existing);
    
    const updated = { ...config, ...data, updated_at: new Date().toISOString() };
    await fs.writeFile(CONFIG_FILE, JSON.stringify(updated, null, 2));
    
    console.log('✅ Configuración guardada');
  } catch (error) {
    console.error('❌ Error al guardar configuración:', error.message);
  }
}

// ==================== FUNCIONES PARA API REGULAR (OAuth) ====================

async function refreshAccessToken() {
  try {
    console.log('🔄 Refrescando access token...');
    
    const response = await axios.post(
      `${KOMMO_CONFIG.baseUrl}/oauth2/access_token`,
      {
        client_id: KOMMO_CONFIG.clientId,
        client_secret: KOMMO_CONFIG.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: KOMMO_CONFIG.refreshToken,
        redirect_uri: KOMMO_CONFIG.redirectUri
      }
    );

    KOMMO_CONFIG.accessToken = response.data.access_token;
    KOMMO_CONFIG.refreshToken = response.data.refresh_token;

    await saveConfig({
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token
    });

    console.log('✅ Token refrescado exitosamente');
    return response.data;
  } catch (error) {
    console.error('❌ Error al refrescar token:', error.response?.data || error.message);
    throw error;
  }
}

async function kommoRequest(method, endpoint, data = null, retryCount = 0) {
  try {
    const config = {
      method,
      url: `${KOMMO_CONFIG.baseUrl}/api/v4${endpoint}`,
      headers: {
        'Authorization': `Bearer ${KOMMO_CONFIG.accessToken}`,
        'Content-Type': 'application/json'
      }
    };

    if (data) config.data = data;

    const response = await axios(config);
    return response.data;
  } catch (error) {
    if (error.response?.status === 401 && retryCount === 0) {
      console.log('⚠️  Token expirado, refrescando...');
      await refreshAccessToken();
      return kommoRequest(method, endpoint, data, retryCount + 1);
    }
    
    if (error.response?.status === 429 && retryCount < 3) {
      const waitTime = 2000 * (retryCount + 1);
      console.log(`⏳ Rate limit, esperando ${waitTime}ms...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
      return kommoRequest(method, endpoint, data, retryCount + 1);
    }

    throw error;
  }
}

// ==================== OBTENER ACCOUNT ID DE CHATS ====================

// Obtener amojo_id (ID de cuenta para Chats API)
app.get('/api/chat/account-id', async (req, res) => {
  try {
    const result = await kommoRequest('GET', '/account?with=amojo_id');
    const amojoId = result.amojo_id;
    
    await saveConfig({ amojoId });
    
    res.json({
      success: true,
      message: 'Account ID obtenido',
      data: {
        amojo_id: amojoId,
        account_id: result.id,
        account_name: result.name
      }
    });
  } catch (error) {
    console.error('❌ Error al obtener account ID:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

// ==================== PASO 1: CONECTAR CANAL AL ACCOUNT ====================

app.post('/api/chat/connect-channel', async (req, res) => {
  try {
    const { account_id } = req.body;
    
    if (!account_id) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere account_id (amojo_id)'
      });
    }

    if (!KOMMO_CONFIG.channelId || !KOMMO_CONFIG.channelSecret) {
      return res.status(400).json({
        success: false,
        error: 'Debes configurar CHANNEL_ID y CHANNEL_SECRET en .env (contacta al soporte de Kommo)'
      });
    }

    const body = { account_id };
    const headers = createChatHeaders(body);

    const response = await axios.post(
      `${KOMMO_CONFIG.chatApiUrl}/${KOMMO_CONFIG.channelId}/connect`,
      body,
      { headers }
    );

    const scopeId = response.data.scope_id;
    KOMMO_CONFIG.scopeId = scopeId;
    
    await saveConfig({ scopeId, account_id });

    res.json({
      success: true,
      message: 'Canal conectado exitosamente',
      data: response.data
    });

  } catch (error) {
    console.error('❌ Error al conectar canal:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

// ==================== PASO 2: CREAR CHAT ====================

app.post('/api/chat/create', async (req, res) => {
  try {
    const { conversation_id, user } = req.body;

    if (!conversation_id || !user) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren conversation_id y user (con id, name, phone)'
      });
    }

    if (!KOMMO_CONFIG.scopeId) {
      return res.status(400).json({
        success: false,
        error: 'Primero debes conectar el canal con POST /api/chat/connect-channel'
      });
    }

    const body = {
      conversation_id,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        email: user.email || ''
      }
    };

    const headers = createChatHeaders(body);

    const response = await axios.post(
      `${KOMMO_CONFIG.chatApiUrl}/${KOMMO_CONFIG.scopeId}/chats`,
      body,
      { headers }
    );

    res.json({
      success: true,
      message: 'Chat creado exitosamente',
      data: response.data
    });

  } catch (error) {
    console.error('❌ Error al crear chat:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

// ==================== PASO 3: ENVIAR MENSAJE ====================

app.post('/api/chat/send-message', async (req, res) => {
  try {
    const { conversation_id, message_text, message_type = 'text', media_url, sender_id, sender_name } = req.body;

    if (!conversation_id || !message_text) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren conversation_id y message_text'
      });
    }

    if (!KOMMO_CONFIG.scopeId) {
      return res.status(400).json({
        success: false,
        error: 'Primero debes conectar el canal'
      });
    }

    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const body = {
      event_type: 'new_message',
      payload: {
        timestamp: Math.floor(Date.now() / 1000),
        msgid: messageId,
        conversation_id,
        sender: {
          id: sender_id || 'system',
          name: sender_name || 'Sistema',
          avatar: ''
        },
        message: {
          type: message_type,
          text: message_text
        }
      }
    };

    if (media_url && (message_type === 'picture' || message_type === 'file')) {
      body.payload.message.media = media_url;
    }

    const headers = createChatHeaders(body);

    const response = await axios.post(
      `${KOMMO_CONFIG.chatApiUrl}/${KOMMO_CONFIG.scopeId}`,
      body,
      { headers }
    );

    res.json({
      success: true,
      message: 'Mensaje enviado exitosamente',
      data: {
        message_id: messageId,
        conversation_id,
        response: response.data
      }
    });

  } catch (error) {
    console.error('❌ Error al enviar mensaje:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

// ==================== VINCULAR CHAT A CONTACTO ====================

app.post('/api/chat/link-contact', async (req, res) => {
  try {
    const { contact_id, chat_id } = req.body;

    if (!contact_id || !chat_id) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren contact_id y chat_id'
      });
    }

    const linkData = [{
      contact_id: parseInt(contact_id),
      chat_id: chat_id
    }];

    const result = await kommoRequest('POST', '/contacts/chats', linkData);

    res.json({
      success: true,
      message: 'Chat vinculado a contacto exitosamente',
      data: result
    });

  } catch (error) {
    console.error('❌ Error al vincular chat:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

// ==================== OBTENER HISTORIAL DE CHAT ====================

app.get('/api/chat/history/:conversation_id', async (req, res) => {
  try {
    const { conversation_id } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    if (!KOMMO_CONFIG.scopeId) {
      return res.status(400).json({
        success: false,
        error: 'Primero debes conectar el canal'
      });
    }

    const url = `${KOMMO_CONFIG.chatApiUrl}/${KOMMO_CONFIG.scopeId}/chats/${conversation_id}/history?limit=${limit}&offset=${offset}`;
    const headers = createChatHeaders('');

    const response = await axios.get(url, { headers });

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {
    console.error('❌ Error al obtener historial:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

// ==================== ACTUALIZAR ESTADO DE ENTREGA ====================

app.post('/api/chat/update-status', async (req, res) => {
  try {
    const { conversation_id, message_id, status } = req.body;

    if (!conversation_id || !message_id || !status) {
      return res.status(400).json({
        success: false,
        error: 'Se requieren conversation_id, message_id y status (delivered/read/error)'
      });
    }

    if (!KOMMO_CONFIG.scopeId) {
      return res.status(400).json({
        success: false,
        error: 'Primero debes conectar el canal'
      });
    }

    const body = {
      conversation_id,
      message_id,
      status
    };

    const headers = createChatHeaders(body);

    const response = await axios.post(
      `${KOMMO_CONFIG.chatApiUrl}/${KOMMO_CONFIG.scopeId}/status`,
      body,
      { headers }
    );

    res.json({
      success: true,
      message: 'Estado actualizado exitosamente',
      data: response.data
    });

  } catch (error) {
    console.error('❌ Error al actualizar estado:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

// ==================== WEBHOOK PARA RECIBIR MENSAJES ====================
// Formato correcto según documentación: https://domain.com/location/:scope_id

app.post('/webhook/chat/:scope_id', async (req, res) => {
  try {
    const { scope_id } = req.params;
    const signature = req.headers['x-signature'];
    const body = req.body;

    console.log('📨 Webhook de chat recibido');
    console.log(`   - Scope ID: ${scope_id}`);
    console.log(`   - Body: ${JSON.stringify(body, null, 2)}`);

    // Verificar firma
    if (!verifyWebhookSignature(JSON.stringify(body), signature)) {
      console.error('❌ Firma inválida en webhook');
      return res.status(401).json({ success: false, error: 'Firma inválida' });
    }

    // Verificar que el scope_id coincida con el configurado
    if (KOMMO_CONFIG.scopeId && scope_id !== KOMMO_CONFIG.scopeId) {
      console.warn(`⚠️  Scope ID no coincide. Recibido: ${scope_id}, Esperado: ${KOMMO_CONFIG.scopeId}`);
    }

    // Procesar el webhook según el tipo de evento
    const { account_id, time, message } = body;

    if (message) {
      console.log('💬 Mensaje recibido:');
      console.log(`   - De: ${message.sender?.name || 'Desconocido'}`);
      console.log(`   - Para: ${message.receiver?.name || 'Desconocido'}`);
      console.log(`   - Tipo: ${message.message?.type}`);
      console.log(`   - Texto: ${message.message?.text}`);
      console.log(`   - Conversation ID: ${message.conversation?.id}`);

      // Aquí puedes agregar tu lógica de negocio
      // Por ejemplo: responder automáticamente, guardar en BD, etc.

      // Actualizar estado a "entregado"
      if (message.message?.id) {
        setTimeout(async () => {
          try {
            const statusBody = {
              conversation_id: message.conversation.id,
              message_id: message.message.id,
              status: 'delivered'
            };
            const headers = createChatHeaders(statusBody);
            
            await axios.post(
              `${KOMMO_CONFIG.chatApiUrl}/${scope_id}`,
              statusBody,
              { headers }
            );
            console.log('✅ Estado actualizado a "delivered"');
          } catch (error) {
            console.error('❌ Error al actualizar estado:', error.message);
          }
        }, 1000);
      }
    }

    // Responder rápidamente al webhook (máximo 5 segundos)
    res.status(200).json({ success: true });

  } catch (error) {
    console.error('❌ Error procesando webhook:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== OAUTH Y ENDPOINTS REGULARES ====================

app.get('/oauth/authorize', (req, res) => {
  const authUrl = `${KOMMO_CONFIG.baseUrl}/oauth?` +
    `client_id=${KOMMO_CONFIG.clientId}&` +
    `redirect_uri=${encodeURIComponent(KOMMO_CONFIG.redirectUri)}&` +
    `response_type=code&` +
    `state=${Math.random().toString(36).substring(7)}`;

  res.redirect(authUrl);
});

app.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ success: false, error: 'No se recibió código' });
  }

  try {
    const response = await axios.post(
      `${KOMMO_CONFIG.baseUrl}/oauth2/access_token`,
      {
        client_id: KOMMO_CONFIG.clientId,
        client_secret: KOMMO_CONFIG.clientSecret,
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: KOMMO_CONFIG.redirectUri
      }
    );

    KOMMO_CONFIG.accessToken = response.data.access_token;
    KOMMO_CONFIG.refreshToken = response.data.refresh_token;

    await saveConfig({
      accessToken: response.data.access_token,
      refreshToken: response.data.refresh_token
    });

    res.json({
      success: true,
      message: 'Autenticación exitosa',
      data: response.data
    });

  } catch (error) {
    console.error('❌ Error en OAuth:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: error.response?.data || error.message
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'OK',
    service: 'Kommo Chat Integration',
    timestamp: new Date().toISOString(),
    config: {
      subdomain: KOMMO_CONFIG.subdomain,
      hasAccessToken: !!KOMMO_CONFIG.accessToken,
      hasRefreshToken: !!KOMMO_CONFIG.refreshToken,
      hasChannelId: !!KOMMO_CONFIG.channelId,
      hasChannelSecret: !!KOMMO_CONFIG.channelSecret,
      hasScopeId: !!KOMMO_CONFIG.scopeId
    }
  });
});

// ==================== INICIO DEL SERVIDOR ====================

const PORT = process.env.PORT || 3000;

async function startServer() {
  await loadConfig();
  
  app.listen(PORT, () => {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║       🚀 Servidor Kommo Chat Integration iniciado        ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    console.log(`📍 Servidor: http://localhost:${PORT}`);
    console.log(`🏢 Subdomain: ${KOMMO_CONFIG.subdomain}`);
    console.log(`✅ OAuth Token: ${KOMMO_CONFIG.accessToken ? 'OK' : '❌ Falta'}`);
    console.log(`✅ Channel ID: ${KOMMO_CONFIG.channelId ? 'OK' : '❌ Falta'}`);
    console.log(`✅ Scope ID: ${KOMMO_CONFIG.scopeId ? 'OK' : '❌ Falta (conecta el canal)'}`);
    console.log('\n📖 Endpoints principales:');
    console.log('   1. GET  /oauth/authorize - Iniciar OAuth');
    console.log('   2. GET  /api/chat/account-id - Obtener amojo_id');
    console.log('   3. POST /api/chat/connect-channel - Conectar canal');
    console.log('   4. POST /api/chat/create - Crear chat');
    console.log('   5. POST /api/chat/send-message - Enviar mensaje');
    console.log('   6. POST /api/chat/link-contact - Vincular chat a contacto');
    console.log('   7. POST /webhook/chat/:scope_id - Recibir mensajes');
    console.log('\n🔔 WEBHOOK URL para configurar en Kommo:');
    console.log(`   https://tu-dominio.com/webhook/chat/:scope_id`);
    console.log('   (Kommo reemplazará automáticamente :scope_id)');
    console.log('\n💡 IMPORTANTE:');
    console.log('   - Primero contacta al soporte de Kommo para registrar tu canal');
    console.log('   - Recibirás CHANNEL_ID y CHANNEL_SECRET');
    console.log('   - Agrega estos valores a tu .env');
    console.log('════════════════════════════════════════════════════════════\n');
  });
}

startServer();