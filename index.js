(() => {
  const EXTENSION_NAME = 'st_voice_lines';
  const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
  const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
  const FALLBACK_MODELS = ['openai/gpt-4o-mini', 'openai/gpt-4o', 'anthropic/claude-3.5-sonnet'];

  const DEFAULT_SETTINGS = {
    apiKey: '',
    model: FALLBACK_MODELS[0],
    prompt:
      'You are a captioning assistant. Pick exactly one emotion from the allowed list that best matches the user dialogue tone. Return only JSON in the form {"emotion":"<allowed_emotion>"}.',
    emotions: ['happy', 'sad', 'angry', 'fearful', 'surprised', 'neutral'],
    enabled: true,
    secondsPerToken: 0.2,
    emotionAudio: {},
  };

  const state = {
    initialized: false,
    processing: new Set(),
    availableModels: [...FALLBACK_MODELS],
  };

  const clone = (obj) => JSON.parse(JSON.stringify(obj));
  const tokenizeCount = (text) => (text.match(/\S+/g) || []).length;

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
      if (!settings.emotionAudio[emotion]) settings.emotionAudio[emotion] = { files: [] };
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
      segments.push({ dialogue, tokensBefore: tokenizeCount(beforeText) });
    }

    return segments;
  };

  const parseEmotionResponse = (content, allowed) => {
    if (!content) return null;

    try {
      const parsed = JSON.parse(content);
      if (parsed?.emotion && allowed.includes(parsed.emotion)) return parsed.emotion;
    } catch {
      // fallback parsing below
    }

    const lowered = content.toLowerCase();
    return allowed.find((emotion) => lowered.includes(emotion.toLowerCase())) || null;
  };

  const classifyEmotion = async (dialogue) => {
    const settings = getSettingsRoot();
    const emotions = settings.emotions.filter(Boolean);
    if (!settings.apiKey || !emotions.length) return null;

    const response = await fetch(OPENROUTER_CHAT_URL, {
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
            content: `Allowed emotions:\n${emotions.map((emotion) => `- ${emotion}`).join('\n')}\n\nDialogue:\n${dialogue}`,
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
    const files = getSettingsRoot().emotionAudio?.[emotion]?.files || [];
    if (!files.length) return null;
    return files[Math.floor(Math.random() * files.length)];
  };

  const scheduleEmotionAudio = (emotion, tokensBefore) => {
    const chosen = pickAudioForEmotion(emotion);
    if (!chosen?.dataUrl) return;

    const delayMs = Math.round(tokensBefore * getSettingsRoot().secondsPerToken * 1000);
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
      (mes.querySelector('.mes_block') || mes).appendChild(container);
    }

    container.textContent = `Caption emotion(s): ${results.map((item) => item.emotion).join(' | ')}`;
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

    const sourceKey = JSON.stringify(segments.map((segment) => segment.dialogue));
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
      const msg = context.chat[i];
      if (!msg || msg.is_user || msg.is_system) continue;
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
    if (!settings.emotions.includes(value)) {
      settings.emotions.push(value);
      settings.emotionAudio[value] = { files: [] };
      renderEmotionList();
      saveSettings();
    }

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

    const settings = getSettingsRoot();
    list.innerHTML = '';

    settings.emotions.forEach((emotion) => {
      const bucket = settings.emotionAudio[emotion] || { files: [] };

      const row = document.createElement('div');
      row.className = 'stvl-emotion-row';

      const left = document.createElement('div');
      left.className = 'stvl-emotion-left';

      const title = document.createElement('div');
      title.className = 'stvl-emotion-title';
      title.textContent = emotion;

      const meta = document.createElement('div');
      meta.className = 'stvl-emotion-meta';
      meta.textContent = `Stored MP3 files: ${bucket.files.length}`;

      const names = document.createElement('div');
      names.className = 'stvl-emotion-files';
      names.textContent = bucket.files.length
        ? bucket.files.map((file) => file.name).join(', ')
        : 'No files uploaded yet';

      left.append(title, meta, names);

      const actions = document.createElement('div');
      actions.className = 'stvl-emotion-actions';

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.mp3,audio/mpeg';
      fileInput.multiple = true;
      fileInput.className = 'stvl-hidden-file-input';

      const uploadButton = document.createElement('button');
      uploadButton.type = 'button';
      uploadButton.className = 'menu_button';
      uploadButton.textContent = 'Upload MP3';
      uploadButton.addEventListener('click', () => fileInput.click());

      fileInput.addEventListener('change', async () => {
        const files = await readFilesAsDataUrl(fileInput.files || []);
        if (!files.length) return;
        bucket.files = [...bucket.files, ...files];
        settings.emotionAudio[emotion] = bucket;
        renderEmotionList();
        saveSettings();
        fileInput.value = '';
      });

      const clearButton = document.createElement('button');
      clearButton.type = 'button';
      clearButton.className = 'menu_button';
      clearButton.textContent = 'Clear MP3s';
      clearButton.addEventListener('click', () => {
        bucket.files = [];
        settings.emotionAudio[emotion] = bucket;
        renderEmotionList();
        saveSettings();
      });

      const removeButton = document.createElement('button');
      removeButton.type = 'button';
      removeButton.className = 'menu_button stvl-remove-emotion';
      removeButton.textContent = 'Remove Emotion';
      removeButton.addEventListener('click', () => removeEmotion(emotion));

      actions.append(fileInput, uploadButton, clearButton, removeButton);
      row.append(left, actions);
      list.appendChild(row);
    });
  };

  const fillModelDropdown = async () => {
    const select = document.getElementById('stvl_model');
    if (!select) return;

    const settings = getSettingsRoot();
    select.innerHTML = '<option value="">Loading models from OpenRouter...</option>';

    try {
      const response = await fetch(OPENROUTER_MODELS_URL);
      if (!response.ok) throw new Error(`Model list request failed (${response.status})`);
      const payload = await response.json();
      const modelIds = (payload?.data || [])
        .map((item) => item?.id)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));

      state.availableModels = modelIds.length ? modelIds : [...FALLBACK_MODELS];
    } catch (error) {
      console.warn('[ST Voice Lines] Could not load OpenRouter model list, using fallback list.', error);
      state.availableModels = [...FALLBACK_MODELS];
    }

    const selected = settings.model;
    select.innerHTML = '';

    state.availableModels.forEach((modelName) => {
      const option = document.createElement('option');
      option.value = modelName;
      option.textContent = modelName;
      select.appendChild(option);
    });

    if (selected && !state.availableModels.includes(selected)) {
      const custom = document.createElement('option');
      custom.value = selected;
      custom.textContent = `${selected} (saved)`;
      select.prepend(custom);
    }

    select.value = selected && [...state.availableModels, selected].includes(selected) ? selected : state.availableModels[0];
    settings.model = select.value;
    saveSettings();
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

        <label>Allowed emotions + MP3 upload</label>
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
    fillModelDropdown();
  };

  const bindEvents = () => {
    const source = globalThis.eventSource;
    const types = globalThis.event_types;
    if (!source || !types || typeof source.on !== 'function') return;

    [types.MESSAGE_RECEIVED, types.CHARACTER_MESSAGE_RENDERED, types.GENERATION_ENDED, types.MESSAGE_SWIPED]
      .filter(Boolean)
      .forEach((eventType) => {
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

    new MutationObserver(() => {
      buildSettingsUi();
    }).observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
