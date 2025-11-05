// server.js - OpenAI to NVIDIA NIM API Proxy (Enhanced Error Handling)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json());

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 REASONING DISPLAY TOGGLE - Shows/hides reasoning in output
const SHOW_REASONING = false; // Set to true to show reasoning with <think> tags

// 🔥 THINKING MODE TOGGLE - Enables thinking for specific models that support it
const ENABLE_THINKING_MODE = false; // Set to true to enable chat_template_kwargs thinking parameter

// Model mapping (adjust based on available NIM models)
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4': 'deepseek/deepseek-r1-0528',
  'gpt-4-turbo': 'moonshotai/kimi-k2-instruct-0905',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1-terminus',
  'claude-3-opus': 'openai/gpt-oss-120b',
  'claude-3-sonnet': 'openai/gpt-oss-20b',
  'gemini-pro': 'qwen/qwen3-next-80b-a3b-thinking' 
};

// Startup check
if (!NIM_API_KEY) {
  console.error('⚠️  WARNING: NIM_API_KEY environment variable is not set!');
  console.error('Please set it in your Render dashboard under Environment variables');
} else {
  console.log('✅ NIM_API_KEY is configured');
  console.log(`Key preview: ${NIM_API_KEY.substring(0, 10)}...`);
}

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'OpenAI to NVIDIA NIM Proxy',
    message: 'Proxy is running! Use /v1/chat/completions for API calls.',
    api_key_configured: !!NIM_API_KEY,
    api_key_preview: NIM_API_KEY ? `${NIM_API_KEY.substring(0, 10)}...` : 'NOT SET',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'OpenAI to NVIDIA NIM Proxy', 
    api_key_configured: !!NIM_API_KEY,
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

// List models endpoint (OpenAI compatible)
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  
  res.json({
    object: 'list',
    data: models
  });
});

// Chat completions endpoint (main proxy)
app.post('/v1/chat/completions', async (req, res) => {
  try {
    // Check if API key is configured
    if (!NIM_API_KEY) {
      console.error('❌ API call failed: NIM_API_KEY not configured');
      return res.status(500).json({
        error: {
          message: 'NVIDIA API key is not configured. Please set NIM_API_KEY environment variable in Render dashboard.',
          type: 'configuration_error',
          code: 500
        }
      });
    }

    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    console.log(`📥 Incoming request for model: ${model}`);
    
    // Smart model selection with fallback
    let nimModel = MODEL_MAPPING[model] || 'meta/llama-3.1-70b-instruct';
    console.log(`🔄 Mapping to NVIDIA model: ${nimModel}`);
    
    // Transform OpenAI request to NIM format
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.7,
      max_tokens: max_tokens || 1024,
      stream: stream || false
    };
    
    console.log(`📤 Sending request to NVIDIA API...`);
    
    // Make request to NVIDIA NIM API
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json',
      validateStatus: function (status) {
        return status < 500; // Don't throw on 4xx errors
      }
    });
    
    // Log the response status
    console.log(`📨 NVIDIA API response status: ${response.status}`);
    
    // Handle error responses
    if (response.status !== 200) {
      console.error(`❌ NVIDIA API error: ${response.status}`);
      console.error(`Error details:`, response.data);
      
      let errorMessage = 'Unknown error from NVIDIA API';
      
      if (response.status === 403) {
        errorMessage = 'NVIDIA API Key is invalid or expired. Please check your NIM_API_KEY in Render environment variables.';
      } else if (response.status === 401) {
        errorMessage = 'NVIDIA API authentication failed. Please verify your NIM_API_KEY.';
      } else if (response.status === 429) {
        errorMessage = 'NVIDIA API rate limit exceeded. Please try again later.';
      } else if (response.data?.detail) {
        errorMessage = `NVIDIA API error: ${response.data.detail}`;
      }
      
      return res.status(response.status).json({
        error: {
          message: errorMessage,
          type: 'nvidia_api_error',
          code: response.status,
          details: response.data
        }
      });
    }
    
    if (stream) {
      console.log(`📡 Starting streaming response...`);
      // Handle streaming response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      response.data.pipe(res);
      
      response.data.on('end', () => {
        console.log(`✅ Streaming response completed`);
      });
      
      response.data.on('error', (err) => {
        console.error('❌ Stream error:', err);
        res.end();
      });
    } else {
      console.log(`✅ Non-streaming response successful`);
      // Transform NIM response to OpenAI format
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => ({
          index: choice.index,
          message: {
            role: choice.message.role,
            content: choice.message.content || ''
          },
          finish_reason: choice.finish_reason
        })),
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
      
      res.json(openaiResponse);
    }
    
  } catch (error) {
    console.error('❌ Proxy error:', error.message);
    
    if (error.response) {
      console.error(`Response status: ${error.response.status}`);
      console.error(`Response data:`, error.response.data);
      
      let errorMessage = error.message;
      
      if (error.response.status === 403) {
        errorMessage = 'NVIDIA API returned 403 Forbidden. Your API key may be invalid, expired, or not authorized for this model. Please:\n1. Check your API key at https://build.nvidia.com/\n2. Verify the key in Render environment variables\n3. Try generating a new API key';
      }
      
      return res.status(error.response.status).json({
        error: {
          message: errorMessage,
          type: 'nvidia_api_error',
          code: error.response.status,
          details: error.response.data
        }
      });
    }
    
    res.status(500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'proxy_error',
        code: 500
      }
    });
  }
});

// Catch-all for unsupported endpoints
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 OpenAI to NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`🔑 API Key configured: ${!!NIM_API_KEY ? 'YES' : 'NO'}`);
  if (NIM_API_KEY) {
    console.log(`   Key preview: ${NIM_API_KEY.substring(0, 10)}...`);
  }
  console.log(`💭 Reasoning display: ${SHOW_REASONING ? 'ENABLED' : 'DISABLED'}`);
  console.log(`🧠 Thinking mode: ${ENABLE_THINKING_MODE ? 'ENABLED' : 'DISABLED'}`);
});
