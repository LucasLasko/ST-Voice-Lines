(() => {
  const EXTENSION_NAME = 'st_voice_lines';
  const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
  const MODEL_OPTIONS = [
    'openai/gpt-4o-mini',
    'openai/gpt-4o',
    'anthropic/claude-3.5-sonnet',
    'anthropic/claude-3.7-sonnet',
    'google/gemini-2.0-flash-001',
    'meta-llama/llama-3.1-70b-instruct',
  ];

  const DEFAULT_SETTINGS = {
    apiKey: '',
    model: MODEL_OPTIONS[0],
    prompt:
      'You are a captioning assistant. Pick exactly one emotion from the allowed list that best matches the user dialogue tone. Return only JSON in the form {"emotion":"<allowed_emotion>"}.',
    emotions: ['happy', 'sad', 'angry', 'fearful', 'surprised', 'neutral'],
    enabled: true,
    secondsPerToken: 0.2,
    emotionAudio: {},
  };

  const state = {
    processing: new Set(),
    initialized: false,
  };

  const tokenizeCount = (text) => (text.match(/\S+/g) || []).length;

  const clone = (obj) => JSON.parse(JSON.stringify(obj));

  const getSettingsRoot = () => {
    if (!globalThis.extension_settings) globalThis.extension_settings = {};
    if (!globalThis.extension_settings[EXTENSION_NAME]) {
      globalThis.extension_settings[EXTENSION_NAME] = clone(DEFAULT_SETTINGS);
    }

    const settings = globalThis.extension_settings[EXTENSION_NAME];
    settings.emotions = Array.isArray(settings.emotions) ? settings.emotions : [...DEFAULT_SETTINGS.emotions];
    settings.emotionAudio = settings.emotionAudio || {};
    settings.secondsPerToken = Number.isFinite(Number(settings.secondsPerToken))
      ? Math.min(1, Math.max(0, Number(settings.secondsPerToken)))
      : DEFAULT_SETTINGS.secondsPerToken;

    settings.emotions.forEach((emotion) => {
      if (!settings.emotionAudio[emotion]) {
        settings.emotionAudio[emotion] = { maxFiles: 3, files: [] };
      }
      settings.emotionAudio[emotion].maxFiles = Math.max(1, Number(settings.emotionAudio[emotion].maxFiles) || 1);
      settings.emotionAudio[emotion].files = Array.isArray(settings.emotionAudio[emotion].files)
        ? settings.emotionAudio[emotion].files
        : [];
    });

    Object.keys(settings.emotionAudio).forEach((emotion) => {
      if (!settings.emotions.includes(emotion)) delete settings.emotionAudio[emotion];
    });

    return settings;
  };

  const saveSettings = () => {
    if (typeof globalThis.saveSettingsDebounced === 'function') globalThis.saveSettingsDebounced();
  };

  const getQuotedDialogueSegments = (text) => {
    if (!text || typeof text !== 'string') return [];

    const regex = /["“]([\s\S]*?)["”]/g;
    const segments = [];
    let match;

    while ((match = regex.exec(text)) !== null) {
      const dialogue = match[1]?.trim();
      if (!dialogue) continue;

      const beforeText = text.slice(0, match.index);
      segments.push({
        dialogue,
        tokensBefore: tokenizeCount(beforeText),
      });
    }

    return segments;
  };

  const parseEmotionResponse = (content, allowed) => {
    if (!content) return null;

    try {
      const parsed = JSON.parse(content);
      if (parsed?.emotion && allowed.includes(parsed.emotion)) return parsed.emotion;
    } catch {
      // relaxed parser fallback
    }

    const lowered = content.toLowerCase();
    return allowed.find((emotion) => lowered.includes(emotion.toLowerCase())) || null;
  };

  const classifyEmotion = async (dialogue) => {
    const settings = getSettingsRoot();
    const emotions = settings.emotions.filter(Boolean);

    if (!settings.apiKey || !emotions.length) return null;

    const response = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model || DEFAULT_SETTINGS.model,
        temperature: 0,
        messages: [
          { role: 'system', content: settings.prompt },
          {
            role: 'user',
            content: `Allowed emotions:\n${emotions.map((e) => `- ${e}`).join('\n')}\n\nDialogue:\n${dialogue}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Captioning AI request failed (${response.status}): ${message}`);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content?.trim();
    return parseEmotionResponse(content, emotions);
  };

  const pickAudioForEmotion = (emotion) => {
    const settings = getSettingsRoot();
    const bucket = settings.emotionAudio?.[emotion];
    if (!bucket?.files?.length) return null;

    const maxFiles = Math.max(1, Number(bucket.maxFiles) || 1);
    const pool = bucket.files.slice(0, maxFiles);
    if (!pool.length) return null;

    const index = Math.floor(Math.random() * pool.length);
    return pool[index];
  };

  const scheduleEmotionAudio = (emotion, tokensBefore) => {
    const settings = getSettingsRoot();
    const chosen = pickAudioForEmotion(emotion);
    if (!chosen?.dataUrl) return;

    const delayMs = Math.round(tokensBefore * settings.secondsPerToken * 1000);
    window.setTimeout(async () => {
      try {
        const audio = new Audio(chosen.dataUrl);
        await audio.play();
      } catch (error) {
        console.warn('[ST Voice Lines] Could not play audio clip:', error);
      }
    }, delayMs);
  };

  const renderEmotionBadge = (messageId, results) => {
    const mes = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (!mes) return;

    let container = mes.querySelector('.stvl-caption-emotion');
    if (!container) {
      container = document.createElement('div');
      container.className = 'stvl-caption-emotion';
      const block = mes.querySelector('.mes_block') || mes;
      block.appendChild(container);
    }

    const summary = results.map((item) => item.emotion).join(' | ');
    container.textContent = `Caption emotion(s): ${summary}`;
  };

  const processMessage = async (messageId) => {
    const key = String(messageId);
    if (state.processing.has(key)) return;

    const settings = getSettingsRoot();
    if (!settings.enabled) return;

    const context = globalThis.getContext?.();
    const message = context?.chat?.[messageId];
    if (!message || message.is_user || message.is_system) return;

    const segments = getQuotedDialogueSegments(message.mes);
    if (!segments.length) return;

    const sourceKey = JSON.stringify(segments.map((s) => s.dialogue));
    message.extra = message.extra || {};

    if (Array.isArray(message.extra.stvlCaptionResults) && message.extra.stvlCaptionSource === sourceKey) {
      renderEmotionBadge(messageId, message.extra.stvlCaptionResults);
      return;
    }

    state.processing.add(key);

    try {
      const results = [];
      for (const segment of segments) {
        const emotion = await classifyEmotion(segment.dialogue);
        if (!emotion) continue;
        results.push({ dialogue: segment.dialogue, emotion, tokensBefore: segment.tokensBefore });
        scheduleEmotionAudio(emotion, segment.tokensBefore);
      }

      if (!results.length) return;

      message.extra.stvlCaptionResults = results;
      message.extra.stvlCaptionSource = sourceKey;
      renderEmotionBadge(messageId, results);

      if (typeof globalThis.saveChatDebounced === 'function') globalThis.saveChatDebounced();
    } catch (error) {
      console.warn('[ST Voice Lines] Captioning failed:', error);
    } finally {
      state.processing.delete(key);
    }
  };

  const processLatestAssistantMessage = async () => {
    const context = globalThis.getContext?.();
    if (!context?.chat?.length) return;

    for (let i = context.chat.length - 1; i >= 0; i--) {
      const message = context.chat[i];
      if (!message || message.is_user || message.is_system) continue;
      await processMessage(i);
      break;
    }
  };

  const removeEmotion = (emotion) => {
    const settings = getSettingsRoot();
    settings.emotions = settings.emotions.filter((item) => item !== emotion);
    delete settings.emotionAudio[emotion];
    renderEmotionList();
    saveSettings();
  };

  const addEmotion = () => {
    const input = document.getElementById('stvl_new_emotion');
    const value = input?.value?.trim();
    if (!value) return;

    const settings = getSettingsRoot();
    if (settings.emotions.includes(value)) {
      input.value = '';
      return;
    }

    settings.emotions.push(value);
    settings.emotionAudio[value] = { maxFiles: 3, files: [] };
    renderEmotionList();
    saveSettings();
    input.value = '';
  };

  const readFilesAsDataUrl = (fileList) =>
    Promise.all(
      [...fileList]
        .filter((file) => (file.type || '').includes('audio') || file.name.toLowerCase().endsWith('.mp3'))
        .map(
          (file) =>
            new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve({ name: file.name, dataUrl: String(reader.result || '') });
              reader.onerror = () => resolve(null);
              reader.readAsDataURL(file);
            }),
        ),
    ).then((items) => items.filter(Boolean));

  const renderEmotionList = () => {
    const list = document.getElementById('stvl_emotions_list');
    if (!list) return;

    list.innerHTML = '';
    const settings = getSettingsRoot();

    settings.emotions.forEach((emotion) => {
      const bucket = settings.emotionAudio[emotion] || { maxFiles: 3, files: [] };

      const row = document.createElement('div');
      row.className = 'stvl-emotion-row';

      const left = document.createElement('div');
      left.className = 'stvl-emotion-left';

      const title = document.createElement('div');
      title.className = 'stvl-emotion-title';
      title.textContent = emotion;

      const meta = document.createElement('div');
      meta.className = 'stvl-emotion-meta';
      meta.textContent = `Loaded clips: ${bucket.files.length}`;

      left.append(title, meta);

      const controls = document.createElement('div');
      controls.className = 'stvl-emotion-actions';

      const count = document.createElement('input');
      count.type = 'number';
      count.className = 'text_pole stvl-small-input';
      count.min = '1';
      count.step = '1';
      count.value = String(bucket.maxFiles || 1);
      count.title = 'How many mp3 files to keep in this emotion category';
      count.addEventListener('change', () => {
        bucket.maxFiles = Math.max(1, Number(count.value) || 1);
        bucket.files = bucket.files.slice(0, bucket.maxFiles);
        settings.emotionAudio[emotion] = bucket;
        renderEmotionList();
        saveSettings();
      });

      const upload = document.createElement('input');
      upload.type = 'file';
      upload.accept = '.mp3,audio/mpeg';
      upload.multiple = true;
      upload.addEventListener('change', async () => {
        const files = await readFilesAsDataUrl(upload.files || []);
        if (!files.length) return;

        bucket.files = [...bucket.files, ...files].slice(0, Math.max(1, Number(bucket.maxFiles) || 1));
        settings.emotionAudio[emotion] = bucket;
        renderEmotionList();
        saveSettings();
        upload.value = '';
      });

      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'menu_button';
      clear.textContent = 'Clear';
      clear.addEventListener('click', () => {
        bucket.files = [];
        settings.emotionAudio[emotion] = bucket;
        renderEmotionList();
        saveSettings();
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'menu_button stvl-remove-emotion';
      remove.textContent = 'Remove Emotion';
      remove.addEventListener('click', () => removeEmotion(emotion));

      controls.append(count, upload, clear, remove);
      row.append(left, controls);
      list.appendChild(row);
    });
  };

  const buildSettingsUi = () => {
    if (document.getElementById('stvl_settings')) return;

    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return;

    const settings = getSettingsRoot();

    const container = document.createElement('div');
    container.id = 'stvl_settings';
    container.className = 'inline-drawer';
    container.innerHTML = `
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>ST Voice Lines — Captioning AI</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <label class="checkbox_label" for="stvl_enabled">
          <input type="checkbox" id="stvl_enabled" /> Enable captioning
        </label>

        <label for="stvl_api_key">Captioning AI API key (OpenRouter)</label>
        <input id="stvl_api_key" type="password" class="text_pole" placeholder="sk-or-..." />

        <label for="stvl_model">Model (OpenRouter)</label>
        <select id="stvl_model" class="text_pole"></select>

        <label for="stvl_prompt">Captioning prompt</label>
        <textarea id="stvl_prompt" class="text_pole" rows="4"></textarea>

        <label for="stvl_token_delay">Token delay per token: <span id="stvl_token_delay_value"></span> sec</label>
        <input id="stvl_token_delay" type="range" min="0" max="1" step="0.05" />

        <label>Allowed emotions + MP3 category controls</label>
        <div id="stvl_emotions_list" class="stvl-emotions-list"></div>

        <div class="stvl-emotion-controls">
          <input id="stvl_new_emotion" type="text" class="text_pole" placeholder="Add emotion" />
          <button id="stvl_add_emotion" type="button" class="menu_button">Add</button>
        </div>
      </div>
    `;

    host.appendChild(container);

    const enabled = document.getElementById('stvl_enabled');
    const apiKey = document.getElementById('stvl_api_key');
    const model = document.getElementById('stvl_model');
    const prompt = document.getElementById('stvl_prompt');
    const tokenDelay = document.getElementById('stvl_token_delay');
    const tokenDelayValue = document.getElementById('stvl_token_delay_value');

    enabled.checked = settings.enabled;
    apiKey.value = settings.apiKey;
    prompt.value = settings.prompt;
    tokenDelay.value = String(settings.secondsPerToken);
    tokenDelayValue.textContent = Number(settings.secondsPerToken).toFixed(2);

    MODEL_OPTIONS.forEach((option) => {
      const el = document.createElement('option');
      el.value = option;
      el.textContent = option;
      model.appendChild(el);
    });
    model.value = settings.model || DEFAULT_SETTINGS.model;

    enabled.addEventListener('change', () => {
      settings.enabled = enabled.checked;
      saveSettings();
    });

    apiKey.addEventListener('input', () => {
      settings.apiKey = apiKey.value.trim();
      saveSettings();
    });

    model.addEventListener('change', () => {
      settings.model = model.value;
      saveSettings();
    });

    prompt.addEventListener('input', () => {
      settings.prompt = prompt.value;
      saveSettings();
    });

    tokenDelay.addEventListener('input', () => {
      settings.secondsPerToken = Math.min(1, Math.max(0, Number(tokenDelay.value) || 0));
      tokenDelayValue.textContent = settings.secondsPerToken.toFixed(2);
      saveSettings();
    });

    document.getElementById('stvl_add_emotion')?.addEventListener('click', addEmotion);
    document.getElementById('stvl_new_emotion')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addEmotion();
      }
    });

    renderEmotionList();
  };

  const bindEvents = () => {
    const source = globalThis.eventSource;
    const types = globalThis.event_types;
    if (!source || !types || typeof source.on !== 'function') return;

    const candidateEvents = [
      types.MESSAGE_RECEIVED,
      types.CHARACTER_MESSAGE_RENDERED,
      types.GENERATION_ENDED,
      types.MESSAGE_SWIPED,
    ].filter(Boolean);

    candidateEvents.forEach((eventType) => {
      source.on(eventType, () => {
        processLatestAssistantMessage();
      });
    });
  };

  const restoreBadgesForVisibleChat = () => {
    const context = globalThis.getContext?.();
    if (!context?.chat) return;

    context.chat.forEach((message, index) => {
      const results = message?.extra?.stvlCaptionResults;
      if (Array.isArray(results) && results.length) renderEmotionBadge(index, results);
    });
  };

  const init = () => {
    if (state.initialized) return;
    state.initialized = true;

    getSettingsRoot();
    buildSettingsUi();
    bindEvents();
    restoreBadgesForVisibleChat();
    processLatestAssistantMessage();

    const observer = new MutationObserver(() => {
      buildSettingsUi();
    });

    observer.observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
