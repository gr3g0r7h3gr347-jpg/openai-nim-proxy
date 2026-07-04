const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

const SHOW_REASONING = true;
const ENABLE_THINKING_MODE = true;

const MODEL_MAPPING = {
  'deepseek-v4-flash': 'deepseek-ai/deepseek-v4-flash',
  'deepseek-v4-pro': 'deepseek-ai/deepseek-v4-pro',
  'kimi-k2.6': 'moonshotai/kimi-k2.6',
  'glm-5.2': 'z-ai/glm-5.2',
  'gemma-4-31b': 'google/gemma-4-31b-it',
  'qwen3.5-397b': 'qwen/qwen3.5-397b-a17b',
  'step-3.7-flash': 'stepfun-ai/step-3.7-flash',
};

if (!NIM_API_KEY) {
  console.error('⚠️  WARNING: NIM_API_KEY environment variable is not set!');
} else {
  console.log('✅ NIM_API_KEY is configured');
  console.log(`Key preview: ${NIM_API_KEY.substring(0, 10)}...`);
}

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'OpenAI to NVIDIA NIM Proxy',
    message: 'Proxy is running! Use /v1/chat/completions for API calls.',
    api_key_configured: !!NIM_API_KEY,
    api_key_preview: NIM_API_KEY ? `${NIM_API_KEY.substring(0, 10)}...` : 'NOT SET',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE,
    available_models: Object.keys(MODEL_MAPPING),
    model_mappings: MODEL_MAPPING
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

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy',
    maps_to: MODEL_MAPPING[model]
  }));
  
  res.json({
    object: 'list',
    data: models
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
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
    
    let nimModel = MODEL_MAPPING[model];
    
    if (!nimModel) {
      console.log(`⚠️  Model "${model}" not in mapping, trying to use directly...`);
      nimModel = model;
    }
    
    console.log(`🔄 Using NVIDIA model: ${nimModel}`);
    
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.7,
      max_tokens: max_tokens || 9024,
      stream: stream || false
    };
    
    console.log(`📤 Sending request to NVIDIA API...`);
    
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json',
      validateStatus: function (status) {
        return status < 500;
      }
    });
    
    console.log(`📨 NVIDIA API response status: ${response.status}`);
    
    if (response.status !== 200) {
      console.error(`❌ NVIDIA API error: ${response.status}`);
      
      let errorMessage = 'Unknown error from NVIDIA API';
      
      if (response.status === 403) {
        errorMessage = 'NVIDIA API Key is invalid or expired.';
      } else if (response.status === 401) {
        errorMessage = 'NVIDIA API authentication failed.';
      } else if (response.status === 404) {
        errorMessage = `Model "${nimModel}" not found on NVIDIA API.`;
      } else if (response.status === 429) {
        errorMessage = 'NVIDIA API rate limit exceeded.';
      } else if (response.status === 503) {
        errorMessage = 'NVIDIA API service temporarily unavailable.';
      } else if (response.status === 500) {
        errorMessage = 'NVIDIA API internal error.';
      } else {
        try {
          if (response.data?.detail) {
            errorMessage = `NVIDIA API error: ${response.data.detail}`;
          } else if (response.data?.message) {
            errorMessage = `NVIDIA API error: ${response.data.message}`;
          }
        } catch (e) {
          errorMessage = `NVIDIA API error (status ${response.status})`;
        }
      }
      
      return res.status(response.status).json({
        error: {
          message: errorMessage,
          type: 'nvidia_api_error',
          code: response.status
        }
      });
    }
    
    if (stream) {
      console.log(`📡 Starting streaming response...`);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let buffer = '';
      let reasoningStarted = false;
      
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            if (line.includes('[DONE]')) {
              res.write(line + '\n\n');
              return;
            }
            
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta) {
                const reasoning = data.choices[0].delta.reasoning_content;
                const content = data.choices[0].delta.content;
                
                if (SHOW_REASONING) {
                  let combinedContent = '';
                  
                  if (reasoning && !reasoningStarted) {
                    combinedContent = '<think>\n' + reasoning;
                    reasoningStarted = true;
                  } else if (reasoning) {
                    combinedContent = reasoning;
                  }
                  
                  if (content && reasoningStarted) {
                    combinedContent += '\n</think>\n\n' + content;
                    reasoningStarted = false;
                  } else if (content) {
                    combinedContent += content;
                  }
                  
                  if (combinedContent) {
                    data.choices[0].delta.content = combinedContent;
                    delete data.choices[0].delta.reasoning_content;
                  }
                } else {
                  if (content) {
                    data.choices[0].delta.content = content;
                  } else {
                    data.choices[0].delta.content = '';
                  }
                  delete data.choices[0].delta.reasoning_content;
                }
              }
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e) {
              res.write(line + '\n\n');
            }
          }
        });
      });
      
      response.data.on('end', () => {
        console.log(`✅ Streaming response completed`);
        res.end();
      });
      
      response.data.on('error', (err) => {
        console.error('❌ Stream error:', err);
        res.end();
      });
    } else {
      console.log(`✅ Non-streaming response successful`);
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        system_fingerprint: `nim_${nimModel.replace(/[^a-z0-9]/gi, '_')}`,
        choices: response.data.choices.map(choice => {
          let content = choice.message?.content || '';
          
          if (SHOW_REASONING && choice.message?.reasoning_content) {
            content = '<think>\n' + choice.message.reasoning_content + '\n</think>\n\n' + content;
          }
          
          return {
            index: choice.index,
            message: {
              role: choice.message?.role || 'assistant',
              content: content
            },
            finish_reason: choice.finish_reason || 'stop'
          };
        }),
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
      
      let errorMessage = error.message;
      
      if (error.response.status === 403) {
        errorMessage = 'NVIDIA API returned 403 Forbidden. Your API key may be invalid or expired.';
      } else if (error.response.status === 404) {
        errorMessage = `Model not found. Check https://build.nvidia.com/explore/discover for available models.`;
      } else if (error.response.status === 500) {
        errorMessage = 'NVIDIA API internal server error.';
      } else if (error.response.status === 503) {
        errorMessage = 'NVIDIA API service temporarily unavailable. Try again in a few moments.';
      }
      
      return res.status(error.response.status).json({
        error: {
          message: errorMessage,
          type: 'nvidia_api_error',
          code: error.response.status
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

app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found. Use /v1/chat/completions for chat requests.`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 OpenAI to NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`📋 Available models: http://localhost:${PORT}/v1/models`);
  console.log(`🔑 API Key configured: ${!!NIM_API_KEY ? 'YES' : 'NO'}`);
  if (NIM_API_KEY) {
    console.log(`   Key preview: ${NIM_API_KEY.substring(0, 10)}...`);
  }
  console.log(`💭 Reasoning display: ${SHOW_REASONING ? 'ENABLED' : 'DISABLED'}`);
  console.log(`🧠 Thinking mode: ${ENABLE_THINKING_MODE ? 'ENABLED' : 'DISABLED'}`);
  console.log(`\n📚 Mapped models: ${Object.keys(MODEL_MAPPING).length}`);
});
