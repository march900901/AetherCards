/* ==========================================================================
   AetherCards (極光單字卡) - 核心應用程式邏輯 (JavaScript)
   ========================================================================== */

// --- 1. 全域應用程式狀態 ---
const state = {
    currentView: 'dashboard',
    decks: [],          // 目前所有的字卡夾
    activeDeckId: null, // 當前操作的字卡夾 ID
    streakDays: 0,      // 連續學習天數
    soundEnabled: true, // 音效開關
    
    // Google Drive 雲端同步狀態
    googleAccessToken: null,
    googleUser: null, // { name, email, picture }
    googleLastSyncTime: null,
    autoSyncEnabled: true,

    // 複習模式臨時狀態
    studySession: {
        cards: [],
        currentIndex: 0,
        isFlipped: false,
        wrongCards: [],      // 記錄此輪學習中被標記為「需複習」的單字卡
        totalInitialCount: 0 // 儲存該輪複習開始時的初始字卡總數
    },
    
    // 測驗模式臨時狀態
    quizSession: {
        cards: [],
        currentIndex: 0,
        answeredCount: 0,
        correctCount: 0,
        maxCombo: 0,
        currentCombo: 0,
        wrongCards: [] // 記錄答錯的卡片
    }
};

// --- 1.2 智慧型 AI 翻譯核心 API ---
async function translateText(text, targetLang = 'zh-TW') {
    if (!text || !text.trim()) return '';
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(text.trim())}`;
        const response = await fetch(url);
        if (!response.ok) return '';
        const data = await response.json();
        if (data && data[0] && data[0][0] && data[0][0][0]) {
            return data[0].map(item => item[0]).join('').trim();
        }
        return '';
    } catch (e) {
        console.error('AI Translation error:', e);
        return '';
    }
}

// --- 1.5 智慧型模糊單字解析器 (Smart Fuzzy Parser) ---
function smartParseLine(line) {
    line = line.trim();
    if (!line) return null;

    let front = '';
    let back = '';

    // 1. 優先匹配顯式分隔符號：# ＃ / ／ | ｜ - — , ， : ： \t
    const separatorRegex = /[ \t]*(?:[\t—\-‐~,，:：#＃|｜/／])[ \t]*/;
    const parts = line.split(separatorRegex);
    
    if (parts.length >= 2) {
        front = parts[0].trim();
        // 合併後面的部分，防範意思中也含有分隔符
        back = parts.slice(1).join(' ').trim();
        
        // 額外清理：如果意思開頭還殘留特殊符號，將其修剪掉
        back = back.replace(/^[\s#＃|｜/／\-—:：,，]+/, '').trim();
    } else {
        // 2. 如果沒有顯式分隔符，尋找第一個「中文/日文」字元的邊界，以利智慧型辨識片語！
        const cjkRegex = /[\u4e00-\u9fa5\u3040-\u30ff\u31f0-\u31ff]/;
        const cjkIndex = line.search(cjkRegex);
        
        if (cjkIndex > 0) {
            front = line.substring(0, cjkIndex).trim();
            back = line.substring(cjkIndex).trim();
            
            // 清除單字結尾或意思開頭殘留的特殊符號（例如 "military service # 兵役" 的情況）
            front = front.replace(/[\s#＃|｜/／\-—:：,，]+$/, '').trim();
            back = back.replace(/^[\s#＃|｜/／\-—:：,，]+/, '').trim();
        } else {
            // 3. 退回到用多個空格切分，最後是單個空格
            const doubleSpaceMatch = line.split(/\s{2,}/);
            if (doubleSpaceMatch.length >= 2) {
                front = doubleSpaceMatch[0].trim();
                back = doubleSpaceMatch.slice(1).join(' ').trim();
            } else {
                const singleSpaceMatch = line.split(/\s+/);
                if (singleSpaceMatch.length >= 2) {
                    front = singleSpaceMatch[0].trim();
                    back = singleSpaceMatch.slice(1).join(' ').trim();
                } else {
                    front = line;
                    back = '';
                }
            }
        }
    }

    return { front, back };
}

// --- 2. INDEXEDDB 本地儲存引擎 (AetherDB) ---
const AetherDB = {
    dbName: 'AetherCardsDB',
    dbVersion: 1,
    db: null,

    // 初始化數據庫
    init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = (e) => reject('數據庫開啟失敗: ' + e.target.error);
            
            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                
                // 建立字卡夾 Store (Decks)
                if (!db.objectStoreNames.contains('decks')) {
                    db.createObjectStore('decks', { keyPath: 'id' });
                }
                
                // 建立字卡 Store (Cards)
                if (!db.objectStoreNames.contains('cards')) {
                    const cardStore = db.createObjectStore('cards', { keyPath: 'id' });
                    cardStore.createIndex('deckId', 'deckId', { unique: false });
                }
            };
        });
    },

    // --- 字卡夾 (Decks) CRUD ---
    getAllDecks() {
        return new Promise((resolve) => {
            const tx = this.db.transaction('decks', 'readonly');
            const store = tx.objectStore('decks');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
        });
    },

    saveDeck(deck) {
        return new Promise((resolve) => {
            const tx = this.db.transaction('decks', 'readwrite');
            const store = tx.objectStore('decks');
            store.put(deck);
            tx.oncomplete = () => {
                CloudSyncManager.triggerDebounceSync();
                resolve(true);
            };
        });
    },

    getDeck(deckId) {
        return new Promise((resolve) => {
            const tx = this.db.transaction('decks', 'readonly');
            const store = tx.objectStore('decks');
            const request = store.get(deckId);
            request.onsuccess = () => resolve(request.result || null);
        });
    },

    deleteDeck(deckId) {
        return new Promise((resolve) => {
            // 刪除字卡夾，並自動刪除其下屬所有單字卡
            const tx = this.db.transaction(['decks', 'cards'], 'readwrite');
            tx.objectStore('decks').delete(deckId);
            
            const cardStore = tx.objectStore('cards');
            const index = cardStore.index('deckId');
            const request = index.openCursor(IDBKeyRange.only(deckId));
            
            request.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                }
            };
            tx.oncomplete = () => {
                CloudSyncManager.triggerDebounceSync();
                resolve(true);
            };
        });
    },

    // --- 單字卡 (Cards) CRUD ---
    getCardsByDeck(deckId) {
        return new Promise((resolve) => {
            const tx = this.db.transaction('cards', 'readonly');
            const store = tx.objectStore('cards');
            const index = store.index('deckId');
            const request = index.getAll(IDBKeyRange.only(deckId));
            request.onsuccess = () => {
                // 按建立時間排序
                const cards = request.result || [];
                cards.sort((a, b) => a.createdAt - b.createdAt);
                resolve(cards);
            };
        });
    },

    saveCard(card) {
        return new Promise((resolve) => {
            const tx = this.db.transaction('cards', 'readwrite');
            const store = tx.objectStore('cards');
            store.put(card);
            tx.oncomplete = () => {
                CloudSyncManager.triggerDebounceSync();
                resolve(true);
            };
        });
    },

    saveCardsBatch(cards) {
        return new Promise((resolve) => {
            const tx = this.db.transaction('cards', 'readwrite');
            const store = tx.objectStore('cards');
            cards.forEach(card => store.put(card));
            tx.oncomplete = () => {
                CloudSyncManager.triggerDebounceSync();
                resolve(true);
            };
        });
    },

    deleteCard(cardId) {
        return new Promise((resolve) => {
            const tx = this.db.transaction('cards', 'readwrite');
            tx.objectStore('cards').delete(cardId);
            tx.oncomplete = () => {
                CloudSyncManager.triggerDebounceSync();
                resolve(true);
            };
        });
    },

    // 刪除全部資料
    clearAllData() {
        return new Promise((resolve) => {
            const tx = this.db.transaction(['decks', 'cards'], 'readwrite');
            tx.objectStore('decks').clear();
            tx.objectStore('cards').clear();
            tx.oncomplete = () => resolve(true);
        });
    }
};

// --- 3. WEB AUDIO 網頁學習音效合成器 ---
const SoundFX = {
    ctx: null,

    init() {
        if (this.ctx) return;
        try {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        } catch (e) {
            console.warn('此瀏覽器不支援 Web Audio API', e);
        }
    },

    playFlip() {
        if (!state.soundEnabled) return;
        this.init();
        if (!this.ctx) return;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(150, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(300, this.ctx.currentTime + 0.15);
        
        gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.15);
        
        osc.start();
        osc.stop(this.ctx.currentTime + 0.15);
    },

    playSuccess() {
        if (!state.soundEnabled) return;
        this.init();
        if (!this.ctx) return;

        // 合成清脆的雙音階和弦
        const playTone = (freq, time, duration) => {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            osc.connect(gain);
            gain.connect(this.ctx.destination);
            
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, time);
            
            gain.gain.setValueAtTime(0.15, time);
            gain.gain.exponentialRampToValueAtTime(0.01, time + duration);
            
            osc.start(time);
            osc.stop(time + duration);
        };

        const now = this.ctx.currentTime;
        playTone(523.25, now, 0.15); // C5
        playTone(659.25, now + 0.08, 0.25); // E5
    },

    playFailure() {
        if (!state.soundEnabled) return;
        this.init();
        if (!this.ctx) return;

        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(180, this.ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(100, this.ctx.currentTime + 0.3);
        
        gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 0.3);
        
        osc.start();
        osc.stop(this.ctx.currentTime + 0.3);
    }
};

// --- 3.5 TEXT-TO-SPEECH (TTS) 語音朗讀引擎 ---
const SpeechEngine = {
    // 智慧型多國語言自動辨識功能
    detectLanguage(text, isFront = true) {
        if (!text) return isFront ? 'en-US' : 'zh-TW';
        
        // 1. 偵測日文字元 (平假名、片假名)
        const hasJapaneseKana = /[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff]/.test(text);
        if (hasJapaneseKana) return 'ja-JP';
        
        // 2. 如果是正面，且當前字卡夾名稱包含「日文」、「日語」、「japan」等，且含有漢字，就視為日文
        if (isFront && state.activeDeckId) {
            const activeDeck = state.decks.find(d => d.id === state.activeDeckId);
            if (activeDeck) {
                const deckName = (activeDeck.name || '').toLowerCase();
                const deckDesc = (activeDeck.description || '').toLowerCase();
                const isJapaneseDeck = deckName.includes('日') || deckName.includes('japan') || 
                                       deckDesc.includes('日') || deckDesc.includes('japan');
                if (isJapaneseDeck && /[\u4e00-\u9fa5]/.test(text)) {
                    return 'ja-JP';
                }
            }
        }
        
        // 3. 偵測中文字元
        const hasChinese = /[\u4e00-\u9fa5]/.test(text);
        if (hasChinese) return 'zh-TW';
        
        // 預設為英文
        return 'en-US';
    },

    // 朗讀指定文字，可自訂語系
    speak(text, lang = 'en-US') {
        if (!window.speechSynthesis) return;
        try {
            // 停止當前正在播放的朗讀，避免聲音重疊混雜
            window.speechSynthesis.cancel();
            
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = lang;
            
            // 智慧速度控制，聽起來更平緩清晰
            utterance.rate = 0.85; 
            utterance.pitch = 1.0;
            
            window.speechSynthesis.speak(utterance);
        } catch (e) {
            console.warn('TTS 語音發音失敗: ', e);
        }
    }
};

// --- 4. CANVAS AI 智慧圖片加載與壓縮引擎 ---
const ImageEngine = {
    // 從外部網址加載圖片並壓縮為 20KB 左右的 Base64 數據
    compressImageFromUrl(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous'; // 允許跨域 Canvas 讀取 (Pollinations & LoremFlickr 均支援)
            
            img.onload = () => {
                try {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');
                    
                    // 設定壓縮後的限制大小 (等比例縮小至最大 280 像素)
                    const maxSize = 280;
                    let width = img.width;
                    let height = img.height;
                    
                    if (width > height) {
                        if (width > maxSize) {
                            height *= maxSize / width;
                            width = maxSize;
                        }
                    } else {
                        if (height > maxSize) {
                            width *= maxSize / height;
                            height = maxSize;
                        }
                    }
                    
                    canvas.width = width;
                    canvas.height = height;
                    
                    // 繪製並壓縮圖片
                    ctx.drawImage(img, 0, 0, width, height);
                    const base64Data = canvas.toDataURL('image/jpeg', 0.65); // 0.65 品質可完美壓縮至 15KB
                    resolve(base64Data);
                } catch (e) {
                    reject('Canvas 繪圖或跨域寫入失敗: ' + e.message);
                }
            };
            
            img.onerror = () => {
                reject('圖片加載超時或網址失效');
            };
            
            img.src = url;
        });
    },

    // 取得 AI 圖片生成網址 (Pollinations.ai)
    getAiGenerateUrl(prompt) {
        // 優化 prompt：加上單詞，限制風格為高質感的明亮插畫，便於記憶
        const safePrompt = encodeURIComponent(prompt.trim() + ' simple vibrant flat vector learning illustration card, white background');
        return `https://image.pollinations.ai/p/${safePrompt}?width=300&height=300&nologo=true&seed=${Math.floor(Math.random() * 1000)}`;
    },

    // 取得 AI 自動相片搜尋網址 (LoremFlickr / Unsplash)
    getAiSearchUrl(keyword) {
        const cleanWord = keyword.trim().replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, ',');
        // 加上隨機 lock 參數，徹底防止並發請求時 LoremFlickr/瀏覽器快取返回同一張重複的圖片！
        const randomLock = Math.floor(Math.random() * 100000);
        return `https://loremflickr.com/300/300/${encodeURIComponent(cleanWord)}?lock=${randomLock}`;
    },

    // 智慧型背景搜圖標籤優化器
    async getSearchKeywords(term, definition) {
        if (!term) return '';
        
        // 1. 如果有斜線或豎線，只取第一個主要詞組 (例如 tilt / lean / slope -> tilt)
        let clean = term.split(/[\/|｜／]/)[0].trim();
        
        // 2. 去除英文或中文括號及其中的解釋內容 (例如 draw (吸引) -> draw)
        clean = clean.replace(/\(.*?\)/g, '').replace(/（.*?）/g, '').trim();
        
        // 3. 去除特殊字元，只保留英文、數字、連字號與空格
        clean = clean.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
        
        // 4. 常見片語高精準度核心詞映射 (對齊優美的 Flickr 照片庫)
        const phraseMapping = {
            'physical fitness': 'fitness',
            'nata de coco': 'coconut',
            'curly fries': 'fries',
            'vacuum cleaner': 'vacuum',
            'steel cable': 'cable',
            'wire rope': 'rope',
            'phrasal verb': 'grammar',
            'indigenous people': 'tribe'
        };
        
        if (phraseMapping[clean]) {
            return phraseMapping[clean];
        }
        
        // 5. 如果是其他片語 (含有空格)，自動提取最後一個核心單詞，確保 100% 匹配成功率
        if (clean.includes(' ')) {
            const words = clean.split(' ');
            return words[words.length - 1];
        }
        
        return clean;
    }
};

// --- 5. 仿 QUIZLET 行流暢表單編輯器 ---
const EditorManager = {
    rows: [], // 編輯器中的行暫存 `{ id, term, definition, hint, example, image, isAiFetching: false }`

    initEditor(deck = null) {
        const rowsContainer = document.getElementById('editor-rows-list');
        rowsContainer.innerHTML = '';
        this.rows = [];

        if (deck) {
            document.getElementById('editor-deck-name').value = deck.name;
            document.getElementById('editor-deck-desc').value = deck.desc || '';
            state.activeDeckId = deck.id;
            
            // 設定主題 Dot 亮起
            const activeTheme = deck.theme || 'grad-aurora';
            document.querySelectorAll('.theme-dot').forEach(dot => {
                if (dot.dataset.theme === activeTheme) {
                    dot.classList.add('active');
                } else {
                    dot.classList.remove('active');
                }
            });

            // 讀取該字卡夾的所有單字卡
            AetherDB.getCardsByDeck(deck.id).then(cards => {
                if (cards.length > 0) {
                    cards.forEach(card => this.addRow(card));
                } else {
                    this.addRow(); // 預設給一行
                }
            });
        } else {
            // 新增模式
            document.getElementById('editor-deck-name').value = '';
            document.getElementById('editor-deck-desc').value = '';
            state.activeDeckId = 'deck_' + Date.now();
            
            // 預設第一個主題亮起
            document.querySelectorAll('.theme-dot').forEach((dot, idx) => {
                if (idx === 0) dot.classList.add('active');
                else dot.classList.remove('active');
            });
            
            // 預設加三行空字卡
            this.addRow();
            this.addRow();
            this.addRow();
        }
    },

    // 新增編輯行
    addRow(cardData = null) {
        const id = cardData ? cardData.id : 'card_' + Math.random().toString(36).substr(2, 9);
        const row = {
            id: id,
            term: cardData ? cardData.front : '',
            definition: cardData ? cardData.back : '',
            hint: cardData ? (cardData.hint || '') : '',
            example: cardData ? (cardData.example || '') : '',
            image: cardData ? (cardData.image || null) : null,
            isAiFetching: false
        };

        this.rows.push(row);
        this.renderRow(row);
    },

    // 渲染單一行 DOM
    renderRow(row) {
        const container = document.getElementById('editor-rows-list');
        const rowCount = this.rows.length;
        
        const rowDiv = document.createElement('div');
        rowDiv.className = 'glass-card editor-row-card border-glow';
        rowDiv.id = `row-card-${row.id}`;
        
        rowDiv.innerHTML = `
            <div class="editor-row-header">
                <span class="row-number"># ${rowCount}</span>
                <button class="btn-delete-row" title="刪除此行" onclick="EditorManager.deleteRow('${row.id}')">
                    <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
                </button>
            </div>
            <div class="editor-row-fields">
                <div class="form-group">
                    <label>正面 (單字/詞彙) *</label>
                    <input type="text" class="input-row-term" value="${row.term}" placeholder="例：Apple" data-row-id="${row.id}">
                </div>
                
                <div class="form-group">
                    <label>反面 (定義/翻譯) *</label>
                    <input type="text" class="input-row-def" value="${row.definition}" placeholder="例：蘋果" data-row-id="${row.id}">
                </div>

                <div class="image-tool-cell">
                    <label>字卡配圖</label>
                    <div class="image-preview-thumbnail" id="preview-thumbnail-${row.id}">
                        ${row.image ? `<img src="${row.image}" alt="插圖">` : `<span class="no-image-tip">尚未配圖</span>`}
                        <div class="image-upload-indicator" id="loading-${row.id}" style="display: none;">AI 載入中...</div>
                    </div>
                    <div class="image-actions-row">
                        <button class="btn-image-action btn-image-ai" onclick="EditorManager.fetchAiImage('${row.id}', 'generate')">AI 繪圖</button>
                        <button class="btn-image-action" onclick="EditorManager.fetchAiImage('${row.id}', 'search')">AI 搜圖</button>
                        <button class="btn-image-action" onclick="EditorManager.triggerLocalUpload('${row.id}')">上傳</button>
                    </div>
                    <input type="file" id="upload-input-${row.id}" accept="image/*" style="display: none;" onchange="EditorManager.handleLocalUpload(this, '${row.id}')">
                </div>
            </div>
        `;

        container.appendChild(rowDiv);
        
        // 綁定動態輸入同步事件
        const termInput = rowDiv.querySelector('.input-row-term');
        const defInput = rowDiv.querySelector('.input-row-def');

        termInput.addEventListener('input', (e) => {
            row.term = e.target.value;
        });

        // 智慧配圖 Autopilot & 自動翻譯：當正面輸入完畢游標離開時
        termInput.addEventListener('blur', async (e) => {
            const termVal = e.target.value.trim();
            if (termVal.length === 0) return;

            // 1. 自動翻譯：如果啟用了「自動翻譯」且「反面定義」目前為空，則背景自動翻譯並填入
            const autoTranslateChecked = document.getElementById('toggle-autotranslate').checked;
            if (autoTranslateChecked && !row.definition.trim()) {
                defInput.placeholder = '🤖 智慧翻譯中...';
                const translation = await translateText(termVal, 'zh-TW');
                if (translation && !row.definition.trim()) { // 再次確認期間使用者沒有自己輸入內容
                    row.definition = translation;
                    defInput.value = translation;
                }
                defInput.placeholder = '例：蘋果';
            }

            // 2. 自動配圖：如果啟用了「自動配圖」且「尚未配圖」
            const autopilotChecked = document.getElementById('toggle-autopilot').checked;
            if (autopilotChecked && !row.image && !row.isAiFetching) {
                this.fetchAiImage(row.id, 'search');
            }
        });

        defInput.addEventListener('input', (e) => {
            row.definition = e.target.value;
        });

        // 仿 Quizlet：在「定義/反面」按下 Tab，如果是最後一行，則自動新增一行並聚焦
        defInput.addEventListener('keydown', (e) => {
            if (e.key === 'Tab' && !e.shiftKey) {
                const isLastRow = this.rows[this.rows.length - 1].id === row.id;
                if (isLastRow) {
                    e.preventDefault(); // 阻止原生 Focus 跳出
                    this.addRow();
                    
                    // 聚焦在剛新增的那一行的 Term 欄位
                    setTimeout(() => {
                        const newRows = container.querySelectorAll('.input-row-term');
                        if (newRows.length > 0) {
                            newRows[newRows.length - 1].focus();
                        }
                    }, 50);
                }
            }
        });
    },

    // 刪除編輯行
    deleteRow(rowId) {
        if (this.rows.length <= 1) {
            alert('字卡夾至少需要包含一張字卡！');
            return;
        }

        this.rows = this.rows.filter(r => r.id !== rowId);
        const element = document.getElementById(`row-card-${rowId}`);
        if (element) {
            element.remove();
        }

        // 重新排序行號
        const container = document.getElementById('editor-rows-list');
        const numberBadges = container.querySelectorAll('.row-number');
        numberBadges.forEach((badge, index) => {
            badge.textContent = `# ${index + 1}`;
        });
    },

    // AI 生成/搜圖按鈕處理
    async fetchAiImage(rowId, type) {
        const row = this.rows.find(r => r.id === rowId);
        if (!row) return;

        const term = row.term.trim();
        if (!term) {
            alert('請先輸入正面單字！');
            return;
        }

        row.isAiFetching = true;
        const loadingIndicator = document.getElementById(`loading-${rowId}`);
        if (loadingIndicator) {
            loadingIndicator.textContent = type === 'generate' ? '🎨 正在 AI 繪圖中...' : '🔍 正在 AI 搜圖中...';
            loadingIndicator.style.display = 'flex';
        }

        try {
            let targetUrl = '';
            if (type === 'generate') {
                targetUrl = ImageEngine.getAiGenerateUrl(term);
            } else {
                // 背景智慧型翻譯定義並取得逗號標籤
                const keywords = await ImageEngine.getSearchKeywords(term, row.definition);
                targetUrl = ImageEngine.getAiSearchUrl(keywords);
            }

            const base64 = await ImageEngine.compressImageFromUrl(targetUrl);
            row.image = base64;
            // 更新預覽 (保留 loadingIndicator 不被 innerHTML 覆蓋刪除)
            const thumbnail = document.getElementById(`preview-thumbnail-${rowId}`);
            if (thumbnail) {
                let img = thumbnail.querySelector('img');
                if (!img) {
                    img = document.createElement('img');
                    img.alt = '插圖';
                    // 移除 "尚未配圖" 的純文字提示
                    const tip = thumbnail.querySelector('.no-image-tip');
                    if (tip) tip.remove();
                    // 在最前端插入新圖片元素，使 loadingIndicator 仍留在後方
                    thumbnail.insertBefore(img, thumbnail.firstChild);
                }
                img.src = base64;
            }
        } catch (err) {
            console.error('AI 配圖失敗: ', err);
            // 失敗時，若 Autopilot 在跑就不打擾，若是手動點擊則警告
            if (type === 'generate') {
                alert('AI 生成此單詞插圖超時，請重新點擊嘗試，或點擊「AI 搜圖」讀取真實攝影。');
            }
        } finally {
            row.isAiFetching = false;
            if (loadingIndicator) loadingIndicator.style.display = 'none';
        }
    },

    // 觸發本機上傳
    triggerLocalUpload(rowId) {
        const fileInput = document.getElementById(`upload-input-${rowId}`);
        if (fileInput) fileInput.click();
    },

    // 處理本機上傳圖片 ( Canvas 壓縮)
    handleLocalUpload(input, rowId) {
        if (!input.files || !input.files[0]) return;
        const file = input.files[0];
        
        const row = this.rows.find(r => r.id === rowId);
        if (!row) return;

        const loadingIndicator = document.getElementById(`loading-${rowId}`);
        if (loadingIndicator) {
            loadingIndicator.textContent = '圖片上傳中...';
            loadingIndicator.style.display = 'flex';
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            ImageEngine.compressImageFromUrl(e.target.result)
                .then(base64 => {
                    row.image = base64;
                    const thumbnail = document.getElementById(`preview-thumbnail-${rowId}`);
                    if (thumbnail) {
                        thumbnail.innerHTML = `<img src="${base64}" alt="插圖">`;
                    }
                })
                .catch(err => {
                    alert('圖片壓縮失敗：' + err);
                })
                .finally(() => {
                    if (loadingIndicator) {
                        loadingIndicator.textContent = 'AI 載入中...';
                        loadingIndicator.style.display = 'none';
                    }
                });
        };
        reader.readAsDataURL(file);
    },

    // 儲存整個字卡夾
    saveDeck() {
        const deckName = document.getElementById('editor-deck-name').value.trim();
        const deckDesc = document.getElementById('editor-deck-desc').value.trim();
        
        if (!deckName) {
            alert('請填寫字卡夾名稱！');
            return;
        }

        const activeThemeDot = document.querySelector('.theme-dot.active');
        const theme = activeThemeDot ? activeThemeDot.dataset.theme : 'grad-aurora';

        // 1. 建立或更新字卡夾
        const deck = {
            id: state.activeDeckId,
            name: deckName,
            desc: deckDesc,
            theme: theme,
            createdAt: Date.now()
        };

        // 2. 轉換字卡資料
        const cardsToSave = [];
        let valid = true;

        this.rows.forEach(row => {
            const front = row.term.trim();
            const back = row.definition.trim();
            
            if (!front || !back) {
                valid = false;
                return;
            }

            cardsToSave.push({
                id: row.id,
                deckId: state.activeDeckId,
                front: front,
                back: back,
                hint: row.hint,
                example: row.example,
                image: row.image,
                mastered: false, // 預設未掌握
                reviews: 0,
                createdAt: Date.now()
            });
        });

        if (!valid) {
            alert('請確保每張字卡都有輸入「正面單字」與「反面意思」！');
            return;
        }

        // 保存到 IndexedDB
        AetherDB.saveDeck(deck)
            .then(() => AetherDB.saveCardsBatch(cardsToSave))
            .then(() => {
                alert('字卡夾儲存成功！');
                AppRouter.navigateTo('deck-detail', state.activeDeckId);
            })
            .catch(err => {
                alert('儲存失敗：' + err);
            });
    }
};

// --- 6. 智慧型批次匯入解析器 ---
const ImporterManager = {
    parsedCards: [],

    parseText() {
        const text = document.getElementById('import-text').value;
        const separatorSelect = document.getElementById('import-separator').value;
        
        if (!text.trim()) {
            alert('請輸入單字內容！');
            return;
        }

        const lines = text.split('\n');
        this.parsedCards = [];

        lines.forEach(line => {
            if (!line.trim()) return;

            let front = '';
            let back = '';

            // 自動或手動偵測分隔符號
            if (separatorSelect === 'auto') {
                const parsed = smartParseLine(line);
                if (parsed) {
                    front = parsed.front;
                    back = parsed.back;
                }
            } else {
                let splitChar = ' - ';
                if (separatorSelect === 'dash') splitChar = ' - ';
                else if (separatorSelect === 'comma') splitChar = ',';
                else if (separatorSelect === 'colon') splitChar = ':';
                else if (separatorSelect === 'tab') splitChar = '\t';

                // 相容全形與多空格
                let parts = [];
                if (separatorSelect === 'comma') {
                    parts = line.split(/[,，]/);
                } else if (separatorSelect === 'colon') {
                    parts = line.split(/[:：]/);
                } else if (separatorSelect === 'dash') {
                    parts = line.split(/[\-—]/);
                } else {
                    parts = line.split(splitChar);
                }

                if (parts.length >= 2) {
                    front = parts[0].trim();
                    back = parts.slice(1).join(' ').trim();
                } else {
                    front = line.trim();
                    back = '';
                }
                
                // 額外清理：如果意思開頭還殘留特殊符號，將其修剪掉
                back = back.replace(/^[\s#＃|｜/／\-—:：,，]+/, '').trim();
            }

            if (front) {
                this.parsedCards.push({
                    front: front,
                    back: back
                });
            }
        });

        // 渲染預覽表格
        const previewBox = document.getElementById('import-preview-box');
        const previewTbody = document.getElementById('import-preview-tbody');
        const previewCount = document.getElementById('import-preview-count');
        
        previewTbody.innerHTML = '';
        
        if (this.parsedCards.length === 0) {
            alert('無法解析任何單字，請檢查文字內容與分隔符號設定！');
            return;
        }

        this.parsedCards.forEach(c => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${c.front}</strong></td>
                <td>${c.back || '<span class="text-danger">（未設定解釋，將建立空白）</span>'}</td>
            `;
            previewTbody.appendChild(tr);
        });

        previewCount.textContent = this.parsedCards.length;
        previewBox.style.display = 'block';
        
        // 滾動到預覽區域
        previewBox.scrollIntoView({ behavior: 'smooth' });
    },

    // 執行將解析後的卡片匯入指定的字卡夾
    executeImport() {
        if (this.parsedCards.length === 0) return;

        const isAutopilot = document.getElementById('import-toggle-autopilot').checked;
        const total = this.parsedCards.length;
        let completed = 0;
        
        // 顯示一個簡易的覆蓋遮罩或進度提示
        const btn = document.getElementById('btn-execute-import');
        const oldText = btn.textContent;
        btn.disabled = true;
        btn.textContent = `⚡ 正在啟動 AI 智慧搜圖 (0/${total})...`;

        // 轉換為完整的卡片結構
        const cardsToSave = this.parsedCards.map(c => ({
            id: 'card_' + Math.random().toString(36).substr(2, 9),
            deckId: state.activeDeckId,
            front: c.front,
            back: c.back || '未填寫',
            hint: '',
            example: '',
            image: null,
            mastered: false,
            reviews: 0,
            createdAt: Date.now()
        }));

        // 如果開啟了 AI 背景配圖，我們採取非同步下載並儲存
        const saveAll = () => {
            AetherDB.saveCardsBatch(cardsToSave)
                .then(() => {
                    alert(`成功匯入 ${total} 張單字卡！`);
                    AppRouter.navigateTo('deck-detail', state.activeDeckId);
                })
                .catch(err => {
                    alert('匯入失敗：' + err);
                })
                .finally(() => {
                    btn.disabled = false;
                    btn.textContent = oldText;
                    document.getElementById('import-text').value = '';
                    document.getElementById('import-preview-box').style.display = 'none';
                });
        };

        if (isAutopilot) {
            // 背景非同步爬圖 ( 每次限制同時請求或順序請求以免阻塞瀏覽器)
            let queue = [...cardsToSave];
            
            const next = async () => {
                if (queue.length === 0) {
                    saveAll();
                    return;
                }

                const card = queue.shift();
                completed++;
                btn.textContent = `🔍 正在 AI 搜圖 [${card.front}] (${completed}/${total})...`;

                try {
                    // 背景智慧型翻譯定義並取得逗號標籤
                    const keywords = await ImageEngine.getSearchKeywords(card.front, card.back);
                    const searchUrl = ImageEngine.getAiSearchUrl(keywords);
                    const base64 = await ImageEngine.compressImageFromUrl(searchUrl);
                    card.image = base64;
                } catch (err) {
                    console.warn(`單字 [${card.front}] AI 配圖失敗（跳過）:`, err);
                } finally {
                    // 連續呼叫，由於是非同步，我們留一點點間隔時間讓瀏覽器喘口氣
                    setTimeout(next, 80);
                }
            };
            next();
        } else {
            saveAll();
        }
    }
};

// --- 7.3 測驗模式選擇彈窗管理器 ---
const QuizSelectModalManager = {
    currentCards: [],
    show(cards) {
        this.currentCards = cards;
        const modal = document.getElementById('quiz-select-modal');
        modal.classList.add('active');
        
        // 綁定三個按鈕事件
        document.getElementById('btn-quiz-spelling').onclick = () => {
            modal.classList.remove('active');
            AppRouter.navigateTo('quiz', this.currentCards);
        };
        
        document.getElementById('btn-quiz-matching').onclick = () => {
            modal.classList.remove('active');
            AppRouter.navigateTo('match', this.currentCards);
        };
        
        document.getElementById('btn-close-quiz-select').onclick = () => {
            modal.classList.remove('active');
        };
    }
};

// --- 7.5 連連看配對遊戲引擎 (Match Game Session) ---
const MatchGameManager = {
    cards: [],
    selectedCards: [], // [{ card, type, element }]
    timerId: null,
    startTime: 0,
    elapsedTime: 0,
    matchedCount: 0,

    init(cards) {
        if (cards.length < 4) {
            alert('字卡夾內至少需要有 4 張單字卡才能開始趣味連連看配對遊戲！');
            AppRouter.navigateTo('deck-detail', state.activeDeckId);
            return;
        }

        // 隱藏成功面板，顯示遊戲網格
        document.getElementById('match-grid-board').style.display = 'grid';
        document.getElementById('match-result-box').style.display = 'none';
        document.getElementById('match-timer-text').textContent = '0.0s';
        
        // 隨機選取 4 張卡片
        const shuffled = [...cards].sort(() => 0.5 - Math.random());
        const selected = shuffled.slice(0, 4);
        this.cards = selected;
        this.selectedCards = [];
        this.matchedCount = 0;
        this.startTime = Date.now();
        this.elapsedTime = 0;

        // 打包 4 個單字 與 4 個意思
        const items = [];
        selected.forEach(c => {
            items.push({ id: c.id, text: c.front, type: 'front', raw: c });
            items.push({ id: c.id, text: c.back, type: 'back', raw: c });
        });

        // 隨機打亂這 8 個 items
        items.sort(() => 0.5 - Math.random());

        // 渲染網格
        const board = document.getElementById('match-grid-board');
        board.innerHTML = '';

        items.forEach(item => {
            const cardDiv = document.createElement('div');
            cardDiv.className = 'match-card';
            cardDiv.textContent = item.text;
            
            // 綁定點擊事件
            cardDiv.onclick = () => this.handleCardSelect(item, cardDiv);
            
            board.appendChild(cardDiv);
        });

        // 啟動計時器
        if (this.timerId) clearInterval(this.timerId);
        this.timerId = setInterval(() => {
            this.elapsedTime = (Date.now() - this.startTime) / 1000;
            document.getElementById('match-timer-text').textContent = this.elapsedTime.toFixed(1) + 's';
        }, 100);

        // 綁定退出與重開按鈕
        document.getElementById('btn-restart-match').onclick = () => this.init(cards);
        document.getElementById('btn-match-result-exit').onclick = () => AppRouter.navigateTo('deck-detail', state.activeDeckId);
    },

    handleCardSelect(item, element) {
        // 如果已經被消除或者已經選中，就不處理
        if (element.classList.contains('matched')) return;
        
        // 如果點選同一個，取消選取
        if (this.selectedCards.some(sc => sc.element === element)) {
            element.classList.remove('selected');
            this.selectedCards = this.selectedCards.filter(sc => sc.element !== element);
            return;
        }

        // 選取該卡片
        element.classList.add('selected');
        this.selectedCards.push({ item, element });

        // 播放點擊音效
        if (state.soundEnabled) SoundFX.playFlip();

        // 如果選滿了兩張，進行比對
        if (this.selectedCards.length === 2) {
            const card1 = this.selectedCards[0];
            const card2 = this.selectedCards[1];

            // 檢查是否是同一張卡片的正面與反面
            if (card1.item.id === card2.item.id && card1.item.type !== card2.item.type) {
                // 配對成功！
                card1.element.classList.add('matched');
                card2.element.classList.add('matched');
                card1.element.classList.remove('selected');
                card2.element.classList.remove('selected');
                
                this.matchedCount++;
                this.selectedCards = [];

                if (state.soundEnabled) SoundFX.playSuccess();

                // 檢查是否全部配對完成
                if (this.matchedCount === 4) {
                    this.endGame();
                }
            } else {
                // 配對失敗！
                card1.element.classList.add('error-flash');
                card2.element.classList.add('error-flash');
                card1.element.classList.remove('selected');
                card2.element.classList.remove('selected');

                if (state.soundEnabled) SoundFX.playFailure();

                // 延遲 400ms 後移除錯誤類別並清空選取
                const scCopy = [...this.selectedCards];
                this.selectedCards = [];
                setTimeout(() => {
                    scCopy[0].element.classList.remove('error-flash');
                    scCopy[1].element.classList.remove('error-flash');
                }, 400);
            }
        }
    },

    endGame() {
        clearInterval(this.timerId);
        this.timerId = null;

        // 播放歡呼音效
        if (state.soundEnabled) SoundFX.playSuccess();

        // 顯示成功面板
        setTimeout(() => {
            document.getElementById('match-grid-board').style.display = 'none';
            document.getElementById('match-result-box').style.display = 'block';
            document.getElementById('match-result-time').textContent = this.elapsedTime.toFixed(2);
        }, 500);
    }
};

// --- 7. 翻字卡引擎 (Study Session) ---
const StudySessionManager = {
    init(cards) {
        if (cards.length === 0) {
            alert('此字卡夾中還沒有單字，請先新增單字！');
            AppRouter.navigateTo('deck-detail', state.activeDeckId);
            return;
        }

        const session = state.studySession;
        
        // 初始化複習狀態
        const shouldShuffle = document.getElementById('toggle-study-shuffle').checked;
        if (shouldShuffle) {
            session.cards = [...cards].sort(() => Math.random() - 0.5); // 隨機打散
        } else {
            session.cards = [...cards]; // 按原始創建順序
        }
        session.currentIndex = 0;
        session.isFlipped = false;
        session.wrongCards = []; // 清空此輪需複習列表
        session.totalInitialCount = cards.length; // 記錄初始單字數

        // 顯示卡片區，隱藏結束選單
        document.getElementById('study-active-box').style.display = 'block';
        document.getElementById('study-end-box').style.display = 'none';

        this.updateUI();
        this.bindEvents();
    },

    updateUI() {
        const session = state.studySession;
        const total = session.cards.length;
        const currentIdx = session.currentIndex;
        
        // 檢查是否所有單字都已經瀏覽完一遍
        if (currentIdx >= total) {
            // 切換畫面：隱藏卡片複習區，顯示結束選擇畫面
            document.getElementById('study-active-box').style.display = 'none';
            document.getElementById('study-end-box').style.display = 'block';

            // 更新結束統計文字
            document.getElementById('study-end-total-count').textContent = session.totalInitialCount;
            document.getElementById('study-end-wrong-count').textContent = session.wrongCards.length;
            document.getElementById('study-btn-wrong-num').textContent = session.wrongCards.length;

            const wrongBtn = document.getElementById('btn-study-review-wrong');
            if (session.wrongCards.length === 0) {
                // 如果全都答對了（沒有標記需複習）
                wrongBtn.disabled = true;
                wrongBtn.style.opacity = '0.5';
                wrongBtn.textContent = '繼續複習剛剛「需複習」的單字 (0) - 已全掌握！';
                
                // 播放完成煙火與大完成鈴聲
                if (state.soundEnabled) SoundFX.playSuccess();
                StreakManager.incrementStreak();
            } else {
                wrongBtn.disabled = false;
                wrongBtn.style.opacity = '1';
                wrongBtn.textContent = `繼續複習剛剛「需複習」的單字 (${session.wrongCards.length})`;
            }
            return;
        }

        // 正常複習中
        document.getElementById('study-active-box').style.display = 'block';
        document.getElementById('study-end-box').style.display = 'none';

        const card = session.cards[currentIdx];
        const defFront = document.getElementById('toggle-def-front').checked;
        
        // 更新進度數據
        document.getElementById('study-current-idx').textContent = currentIdx + 1;
        document.getElementById('study-total-count').textContent = total;
        
        const percent = (currentIdx / total) * 100;
        document.getElementById('study-progress-bar').style.width = `${percent}%`;

        // 填入正面與反面內容
        if (defFront) {
            // 正面是意思
            document.getElementById('study-card-front-term').textContent = card.back;
            document.getElementById('study-card-front-hint').textContent = '';
            
            document.getElementById('study-card-back-def').textContent = card.front;
            document.getElementById('study-card-back-example').textContent = (card.hint ? `[${card.hint}] ` : '') + (card.example || '');
        } else {
            // 正面是單字
            document.getElementById('study-card-front-term').textContent = card.front;
            document.getElementById('study-card-front-hint').textContent = card.hint ? `音標: [${card.hint}]` : '';
            
            document.getElementById('study-card-back-def').textContent = card.back;
            document.getElementById('study-card-back-example').textContent = card.example || '';
        }
        
        // 填入圖片
        const imageBox = document.getElementById('study-card-image-box');
        const imageEl = document.getElementById('study-card-image');
        if (card.image) {
            imageEl.src = card.image;
            imageBox.style.display = 'block';
        } else {
            imageEl.src = '';
            imageBox.style.display = 'none';
        }

        // 渲染底層下一張預覽卡 (Tinder 疊卡效果)
        const previewEl = document.getElementById('flashcard-next-preview');
        const previewTermEl = document.getElementById('study-next-preview-term');
        if (currentIdx + 1 < total) {
            const nextCard = session.cards[currentIdx + 1];
            previewTermEl.textContent = defFront ? nextCard.back : nextCard.front;
            previewEl.style.display = 'flex';
        } else {
            previewEl.style.display = 'none';
        }

        // 綁定 TTS 朗讀按鈕事件
        document.getElementById('btn-tts-front').onclick = (e) => {
            e.stopPropagation(); // 阻止翻牌觸發
            const textToSpeak = defFront ? card.back : card.front;
            const isFront = !defFront;
            SpeechEngine.speak(textToSpeak, SpeechEngine.detectLanguage(textToSpeak, isFront));
        };

        document.getElementById('btn-tts-back').onclick = (e) => {
            e.stopPropagation(); // 阻止翻牌觸發
            const textToSpeak = defFront ? card.front : card.back;
            const isFront = defFront;
            SpeechEngine.speak(textToSpeak, SpeechEngine.detectLanguage(textToSpeak, isFront));
        };

        // 重置翻牌狀態
        const cardElement = document.getElementById('flashcard-element');
        cardElement.classList.remove('flipped');
        session.isFlipped = false;

        // 智慧型自動朗讀正面功能：如果勾選了「朗讀單字」，切換到此卡片時自動發音
        const autoTtsChecked = document.getElementById('toggle-auto-tts').checked;
        if (autoTtsChecked) {
            setTimeout(() => {
                if (state.currentView === 'study' && session.currentIndex === currentIdx && !session.isFlipped) {
                    const textToSpeak = defFront ? card.back : card.front;
                    SpeechEngine.speak(textToSpeak, SpeechEngine.detectLanguage(textToSpeak, !defFront));
                }
            }, 250);
        }
    },

    flipCard() {
        const cardElement = document.getElementById('flashcard-element');
        cardElement.classList.toggle('flipped');
        state.studySession.isFlipped = !state.studySession.isFlipped;
        
        if (state.soundEnabled) SoundFX.playFlip();

        const session = state.studySession;
        const card = session.cards[session.currentIndex];
        const defFront = document.getElementById('toggle-def-front').checked;
        
        if (state.studySession.isFlipped && card) {
            const speakBackChecked = document.getElementById('toggle-auto-tts-back').checked;
            if (speakBackChecked) {
                setTimeout(() => {
                    if (state.currentView === 'study' && session.currentIndex === session.currentIndex && state.studySession.isFlipped) {
                        const textToSpeak = defFront ? card.front : card.back;
                        SpeechEngine.speak(textToSpeak, SpeechEngine.detectLanguage(textToSpeak, defFront));
                    }
                }, 250); // 延遲 250ms 等翻牌動畫轉到背部
            }
        } else if (!state.studySession.isFlipped && card) {
            const speakFrontChecked = document.getElementById('toggle-auto-tts').checked;
            if (speakFrontChecked) {
                setTimeout(() => {
                    if (state.currentView === 'study' && session.currentIndex === session.currentIndex && !state.studySession.isFlipped) {
                        const textToSpeak = defFront ? card.back : card.front;
                        SpeechEngine.speak(textToSpeak, SpeechEngine.detectLanguage(textToSpeak, !defFront));
                    }
                }, 250); // 延遲 250ms 等翻牌動畫轉回正面
            }
        }
    },

    // 標記字卡掌握度評估 (Tinder 左右飛出動畫)
    evaluate(mastered) {
        const session = state.studySession;
        if (session.currentIndex >= session.cards.length) return;

        const card = session.cards[session.currentIndex];

        // 1. 更新卡片歷史記錄與大腦記憶數據
        card.reviews = (card.reviews || 0) + 1;
        card.mastered = mastered;

        // 2. 寫入本地資料庫
        AetherDB.saveCard(card);

        // 3. 核心變革：點選「需複習」時不讓剩餘數量動態增加，而是存入 wrongCards 陣列！
        if (!mastered) {
            session.wrongCards.push(card);
            if (state.soundEnabled) SoundFX.playFlip(); // 需複習播放微翻牌提示
        } else {
            if (state.soundEnabled) SoundFX.playSuccess(); // 已掌握播放清脆短音
        }

        // 4. 觸發 Tinder 左右滑動飛出動畫
        const scene = document.getElementById('interactive-card-scene');
        const previewEl = document.getElementById('flashcard-next-preview');
        
        if (mastered) {
            scene.classList.add('slide-right');
        } else {
            scene.classList.add('slide-left');
        }

        // 同時讓預覽卡放大，增強層次過渡感
        if (previewEl) {
            previewEl.style.transform = 'scale(1) translateY(0px)';
            previewEl.style.opacity = '1';
        }

        // 延遲 350ms，等待飛出動畫播完，再無感切換至下一張卡
        setTimeout(() => {
            // 核心修復：如果目前是反面狀態，瞬間無動畫歸零至正面，徹底防止看到下個單字的意思！
            const cardElement = document.getElementById('flashcard-element');
            if (session.isFlipped) {
                cardElement.classList.add('no-transition');
                cardElement.classList.remove('flipped');
                cardElement.offsetHeight; // 強制 Reflow 讓 DOM 瞬間完成翻牌
                cardElement.classList.remove('no-transition');
                session.isFlipped = false;
            }

            // 移至下一張卡片
            session.currentIndex++;
            
            // 移除動畫與過渡樣式，讓場景與預覽歸位
            scene.classList.remove('slide-left');
            scene.classList.remove('slide-right');
            if (previewEl) {
                previewEl.style.transform = '';
                previewEl.style.opacity = '';
            }

            this.updateUI();
        }, 350);
    },

    bindEvents() {
        // 點擊卡片翻轉
        const cardElement = document.getElementById('flashcard-element');
        cardElement.onclick = () => this.flipCard();

        // 綁定「正面是意思」開關變更事件
        document.getElementById('toggle-def-front').onchange = () => {
            this.updateUI();
        };

        // 綁定結束畫面按鈕事件
        document.getElementById('btn-study-review-wrong').onclick = () => {
            const session = state.studySession;
            if (session.wrongCards.length === 0) return;

            // 將錯字複製為下一輪的複習卡片，並打散
            this.init(session.wrongCards);
        };

        document.getElementById('btn-study-review-all').onclick = () => {
            const session = state.studySession;
            AetherDB.getCardsByDeck(state.activeDeckId).then(cards => {
                this.init(cards);
            });
        };

        document.getElementById('btn-study-end-exit').onclick = () => {
            AppRouter.navigateTo('deck-detail', state.activeDeckId);
        };
        
        // 鍵盤快捷鍵綁定 (保留原版完整邏輯！)
        window.onkeydown = null;
        window.onkeydown = (e) => {
            if (state.currentView !== 'study') return;

            // 確保沒有在選單畫面觸發
            const activeBox = document.getElementById('study-active-box');
            if (activeBox.style.display === 'none') return;

            if (e.key === ' ' || e.code === 'Space') {
                e.preventDefault();
                this.flipCard();
            } else if (e.key === '1') {
                this.evaluate(false); // 需複習
            } else if (e.key === '2') {
                this.evaluate(true); // 已掌握
            } else if (e.key === 'ArrowLeft') {
                // 上一張
                if (state.studySession.currentIndex > 0) {
                    state.studySession.currentIndex--;
                    this.updateUI();
                }
            } else if (e.key === 'ArrowRight') {
                // 下一張
                if (state.studySession.currentIndex < state.studySession.cards.length - 1) {
                    state.studySession.currentIndex++;
                    this.updateUI();
                }
            }
        };
    }
};

// --- 8. 寫作拼寫測驗引擎 (Spelling Quiz) ---
const QuizSessionManager = {
    init(cards) {
        if (cards.length === 0) {
            alert('此字卡夾中還沒有單字，請先新增單字！');
            AppRouter.navigateTo('deck-detail', state.activeDeckId);
            return;
        }

        state.quizSession = {
            cards: [...cards].sort(() => Math.random() - 0.5), // 亂序測驗
            currentIndex: 0,
            answeredCount: 0,
            correctCount: 0,
            maxCombo: 0,
            currentCombo: 0,
            wrongCards: []
        };

        // 顯示問答 UI
        document.getElementById('quiz-question-box').style.display = 'block';
        document.getElementById('quiz-result-box').style.display = 'none';

        this.updateQuestion();
    },

    updateQuestion() {
        const session = state.quizSession;
        const total = session.cards.length;
        
        if (session.currentIndex >= total) {
            // 測驗結束！
            this.showResults();
            return;
        }

        const card = session.cards[session.currentIndex];

        // 進度與答題率更新
        document.getElementById('quiz-answered-count').textContent = session.answeredCount;
        document.getElementById('quiz-score-num').textContent = session.correctCount;
        
        const ratePercent = session.answeredCount > 0 ? 
            Math.round((session.correctCount / session.answeredCount) * 100) : 100;
        document.getElementById('quiz-correct-rate').textContent = `${ratePercent}%`;

        const progressPercent = (session.currentIndex / total) * 100;
        document.getElementById('quiz-progress-bar').style.width = `${progressPercent}%`;

        // 填充圖片與中文 cues
        const imgContainer = document.getElementById('quiz-image-container');
        const imgEl = document.getElementById('quiz-image');
        if (card.image) {
            imgEl.src = card.image;
            imgContainer.style.display = 'block';
        } else {
            imgEl.src = '';
            imgContainer.style.display = 'none';
        }

        document.getElementById('quiz-cue-def').textContent = card.back;
        document.getElementById('quiz-cue-example').textContent = card.example || '';

        // 清空輸入框
        const input = document.getElementById('quiz-user-input');
        input.value = '';
        input.disabled = false;
        input.readOnly = false;
        input.focus();

        // 隱藏上一題反饋
        const feedback = document.getElementById('quiz-feedback-box');
        feedback.style.display = 'none';
        
        // 啟用提交按鈕，隱藏下一題按鈕
        document.getElementById('btn-submit-answer').style.display = 'inline-flex';
        document.getElementById('btn-submit-answer').disabled = false;
        document.getElementById('btn-next-quiz').style.display = 'none';
    },

    submitAnswer(e) {
        if (e) e.preventDefault();
        
        const session = state.quizSession;
        const card = session.cards[session.currentIndex];
        
        const userInput = document.getElementById('quiz-user-input').value.trim();
        if (!userInput) return;

        // 比對拼寫（不分大小寫，去除前後空白）
        const isCorrect = userInput.toLowerCase() === card.front.toLowerCase();
        
        session.answeredCount++;

        // 鎖定輸入
        const input = document.getElementById('quiz-user-input');
        input.readOnly = true;
        document.getElementById('btn-submit-answer').style.display = 'none';
        document.getElementById('btn-next-quiz').style.display = 'inline-flex';
        document.getElementById('btn-next-quiz').focus();

        const feedbackBox = document.getElementById('quiz-feedback-box');
        const feedbackText = document.getElementById('quiz-feedback-text');
        const correctText = document.getElementById('quiz-correct-answer-text');
        const cardWrapper = document.getElementById('quiz-card-wrapper');

        feedbackBox.style.display = 'flex';
        feedbackBox.className = 'quiz-feedback-banner';

        if (isCorrect) {
            // 答對了
            session.correctCount++;
            session.currentCombo++;
            session.maxCombo = Math.max(session.maxCombo, session.currentCombo);
            
            feedbackText.textContent = '答對了！太棒了！🎉';
            correctText.style.display = 'none';
            feedbackBox.classList.add('correct');

            SoundFX.playSuccess();
            this.spawnConfetti(); // 答對發射彩帶粒子！
            
            // 更新本地單字卡大腦學習數據
            card.mastered = true;
            card.reviews = (card.reviews || 0) + 1;
            AetherDB.saveCard(card);
        } else {
            // 答錯了
            session.currentCombo = 0;
            feedbackText.textContent = '差了一點，繼續加油！❌';
            correctText.innerHTML = `正確答案：<strong class="highlight">${card.front}</strong>`;
            correctText.style.display = 'block';
            feedbackBox.classList.add('incorrect');

            SoundFX.playFailure();
            
            // 觸發輸入框紅光震動
            cardWrapper.classList.add('shake-error');
            setTimeout(() => {
                cardWrapper.classList.remove('shake-error');
            }, 450);

            // 自動將答錯的卡片加入本機的「需加強複習」
            card.mastered = false;
            card.reviews = (card.reviews || 0) + 1;
            AetherDB.saveCard(card);
            
            session.wrongCards.push(card);
        }
    },

    nextQuestion() {
        const session = state.quizSession;
        session.currentIndex++;
        this.updateQuestion();
    },

    // 答對時的精美 DOM 彩色碎片發射效果 (無任何外部函式庫相依性)
    spawnConfetti() {
        const container = document.body;
        const colors = ['#00f2c3', '#bd5cfa', '#3b82f6', '#fbbf24', '#ff4a76'];
        
        for (let i = 0; i < 40; i++) {
            const dot = document.createElement('div');
            dot.style.position = 'fixed';
            dot.style.zIndex = '9999';
            dot.style.width = `${Math.random() * 8 + 6}px`;
            dot.style.height = `${Math.random() * 8 + 6}px`;
            dot.style.borderRadius = Math.random() > 0.5 ? '50%' : '2px';
            dot.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
            
            // 起始位置在畫面中心或輸入框上方
            const startX = window.innerWidth / 2;
            const startY = window.innerHeight * 0.7;
            dot.style.left = `${startX}px`;
            dot.style.top = `${startY}px`;
            
            container.appendChild(dot);
            
            // 設定拋射的隨機角度與速度
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * 12 + 6;
            let vx = Math.cos(angle) * speed;
            let vy = Math.sin(angle) * speed - 8; // 稍微往上噴發
            
            let posX = startX;
            let posY = startY;
            let gravity = 0.4;
            let rotation = Math.random() * 360;
            let rotateSpeed = Math.random() * 10 - 5;
            
            const animate = () => {
                vy += gravity;
                posX += vx;
                posY += vy;
                rotation += rotateSpeed;
                
                dot.style.transform = `translate(${posX - startX}px, ${posY - startY}px) rotate(${rotation}deg)`;
                dot.style.opacity = `${parseFloat(dot.style.opacity || 1) - 0.015}`;
                
                if (parseFloat(dot.style.opacity) > 0 && posY < window.innerHeight) {
                    requestAnimationFrame(animate);
                } else {
                    dot.remove();
                }
            };
            
            setTimeout(() => {
                requestAnimationFrame(animate);
            }, 10);
        }
    },

    showResults() {
        const session = state.quizSession;
        
        // 隱藏問答，顯示統計結果
        document.getElementById('quiz-question-box').style.display = 'none';
        document.getElementById('quiz-result-box').style.display = 'block';

        const ratePercent = Math.round((session.correctCount / session.cards.length) * 100);
        
        document.getElementById('result-score-percent').textContent = `${ratePercent}%`;
        document.getElementById('result-correct-count').textContent = session.correctCount;
        document.getElementById('result-total-count').textContent = session.cards.length;
        document.getElementById('result-max-combo').textContent = session.maxCombo;

        // 如果有錯字，顯示錯字列表以利自我省思
        const wrongPanel = document.getElementById('result-wrong-list-panel');
        const wrongUl = document.getElementById('result-wrong-ul');
        
        wrongUl.innerHTML = '';
        
        if (session.wrongCards.length > 0) {
            session.wrongCards.forEach(c => {
                const li = document.createElement('li');
                li.innerHTML = `
                    <span><strong>${c.front}</strong></span>
                    <span>${c.back}</span>
                `;
                wrongUl.appendChild(li);
            });
            wrongPanel.style.display = 'block';
        } else {
            wrongPanel.style.display = 'none';
        }

        // 計算 Streak 連勝
        StreakManager.incrementStreak();
    }
};

// --- 9. 學習連勝紀錄管理器 (Streak Manager) ---
const StreakManager = {
    init() {
        const lastLearnDate = localStorage.getItem('lastLearnDate');
        const currentStreak = parseInt(localStorage.getItem('streakDays') || '0');
        
        if (!lastLearnDate) {
            state.streakDays = 0;
        } else {
            const todayStr = new Date().toDateString();
            const lastDate = new Date(lastLearnDate);
            const diffTime = Math.abs(new Date(todayStr) - lastDate);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            
            if (diffDays === 1) {
                // 連續的第二天
                state.streakDays = currentStreak;
            } else if (diffDays > 1) {
                // 斷掉了
                state.streakDays = 0;
                localStorage.setItem('streakDays', '0');
            } else {
                // 今天已經學過了
                state.streakDays = currentStreak;
            }
        }
        this.updateUI();
    },

    incrementStreak() {
        const todayStr = new Date().toDateString();
        const lastLearnDate = localStorage.getItem('lastLearnDate');
        
        if (lastLearnDate !== todayStr) {
            let streak = parseInt(localStorage.getItem('streakDays') || '0');
            streak += 1;
            
            localStorage.setItem('streakDays', streak.toString());
            localStorage.setItem('lastLearnDate', todayStr);
            state.streakDays = streak;
            
            this.updateUI();
        }
    },

    updateUI() {
        document.getElementById('sidebar-streak-num').textContent = state.streakDays;
    }
};

// --- 10. 資料備份與 JSON 檔案匯入/匯出引擎 ---
const BackupEngine = {
    // 匯出全部資料
    exportAll() {
        const backupData = {
            version: 1,
            exportTime: Date.now(),
            streakDays: state.streakDays,
            decks: [],
            cards: []
        };

        // 一步步讀取並組裝 JSON
        AetherDB.getAllDecks()
            .then(decks => {
                backupData.decks = decks;
                
                // 讀取所有單字卡
                const promises = decks.map(d => AetherDB.getCardsByDeck(d.id));
                return Promise.all(promises);
            })
            .then(cardsLists => {
                // 將所有字卡展平為一個大陣列
                backupData.cards = cardsLists.flat();
                
                // 輸出為 JSON 並觸發瀏覽器下載
                const jsonStr = JSON.stringify(backupData, null, 2);
                const blob = new Blob([jsonStr], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                
                const a = document.createElement('a');
                a.href = url;
                a.download = `aether_cards_backup_${new Date().toISOString().slice(0,10)}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                
                alert('字卡備份匯出成功！您可以將此檔案保存於電腦或雲端硬碟中。');
            })
            .catch(err => {
                alert('備份匯出失敗：' + err);
            });
    },

    // 匯入備份資料
    importAll(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                
                if (!data.decks || !data.cards) {
                    alert('備份檔案格式不正確，無法匯入！');
                    return;
                }

                if (!confirm(`確認要還原此備份嗎？這將會合併並載入備份中的 ${data.decks.length} 個字卡夾與 ${data.cards.length} 張單字卡。`)) {
                    return;
                }

                // 批次寫入
                const deckPromises = data.decks.map(d => AetherDB.saveDeck(d));
                const cardPromises = AetherDB.saveCardsBatch(data.cards);
                
                Promise.all([...deckPromises, cardPromises])
                    .then(() => {
                        // 還原 Streak 連勝天數
                        if (data.streakDays) {
                            localStorage.setItem('streakDays', data.streakDays.toString());
                            state.streakDays = data.streakDays;
                        }
                        
                        alert('備份還原還原成功！');
                        AppRouter.navigateTo('dashboard');
                        window.location.reload(); // 重整頁面使畫面更新
                    })
                    .catch(err => {
                        alert('還原寫入失敗：' + err);
                    });
            } catch (err) {
                alert('解析 JSON 檔案錯誤：' + err);
            }
        };
        reader.readAsText(file);
    },

    // 匯出單個字卡夾分享包
    exportSingleDeck(deckId) {
        let targetDeck = null;
        AetherDB.getDeck(deckId)
            .then(deck => {
                if (!deck) throw new Error('找不到該字卡夾');
                targetDeck = deck;
                return AetherDB.getCardsByDeck(deckId);
            })
            .then(cards => {
                const exportData = {
                    aetherCardsExport: true,
                    type: 'single-deck',
                    exportTime: Date.now(),
                    deck: {
                        name: targetDeck.name,
                        desc: targetDeck.desc || '',
                        theme: targetDeck.theme || 'grad-aurora'
                    },
                    cards: cards.map(c => ({
                        front: c.front,
                        back: c.back,
                        hint: c.hint || '',
                        example: c.example || '',
                        image: c.image || null
                    }))
                };

                const jsonStr = JSON.stringify(exportData, null, 2);
                const fileName = `${targetDeck.name.replace(/[\/\\?%*:|"<>. ]/g, '_')}_字卡分享包.json`;
                const blob = new Blob([jsonStr], { type: 'application/json' });
                const file = new File([blob], fileName, { type: 'application/json' });

                // 如果行動端支援原生 Web Share API 且允許分享檔案
                if (navigator.canShare && navigator.canShare({ files: [file] })) {
                    navigator.share({
                        files: [file],
                        title: `分享字卡夾：${targetDeck.name}`,
                        text: `我跟你分享了 AetherCards 的字卡夾「${targetDeck.name}」，快下載此檔案並匯入吧！`
                    }).catch(err => {
                        console.warn('Native share failed, fallback to download:', err);
                        this.triggerDownload(blob, fileName);
                    });
                } else {
                    this.triggerDownload(blob, fileName);
                }
            })
            .catch(err => {
                alert('分享字卡夾失敗：' + err);
            });
    },

    triggerDownload(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        alert('字卡分享包產生成功並開始下載！您可以將此 JSON 檔案傳送給別的裝置匯入。');
    },

    // 匯入單個字卡夾分享包
    importSingleDeck(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = JSON.parse(e.target.result);
                
                if (!data.aetherCardsExport || data.type !== 'single-deck' || !data.deck || !data.cards) {
                    alert('此檔案不是合法的單個字卡夾分享包！');
                    return;
                }

                const deckName = data.deck.name;
                if (!confirm(`確認要匯入分享的字卡夾「${deckName}」嗎？這將會在此裝置建立一個新字卡夾並載入其包含的 ${data.cards.length} 張單字卡。`)) {
                    return;
                }

                // 建立一個全新的字卡夾 ID，防止覆蓋現有同名檔案
                const newDeckId = 'deck_' + Date.now();
                const newDeck = {
                     id: newDeckId,
                     name: deckName + ' (分享匯入)',
                     desc: data.deck.desc || '自別的裝置匯入的分享字卡夾',
                     theme: data.deck.theme || 'grad-aurora'
                };

                // 重新分配字卡的 deckId 並且給予新 ID
                const newCards = data.cards.map(c => ({
                     id: 'card_' + Math.random().toString(36).substr(2, 9),
                     deckId: newDeckId,
                     front: c.front,
                     back: c.back,
                     hint: c.hint || '',
                     example: c.example || '',
                     image: c.image || null,
                     mastered: false,
                     reviews: 0
                }));

                // 寫入本機資料庫
                AetherDB.saveDeck(newDeck)
                     .then(() => AetherDB.saveCardsBatch(newCards))
                     .then(() => {
                         alert(`字卡夾「${deckName}」已成功匯入！`);
                         AppRouter.navigateTo('deck-detail', newDeckId);
                         window.location.reload();
                     })
                     .catch(err => {
                         alert('匯入寫入失敗：' + err);
                     });
            } catch (err) {
                alert('解析 JSON 檔案錯誤：' + err);
            }
        };
        reader.readAsText(file);
    }
};

// --- 10.5 GOOGLE DRIVE 雲端同步管理引擎 ---
const CloudSyncManager = {
    clientId: '486668402868-fie81bjqqujsmg6jdth5ur1mu5o66p4u.apps.googleusercontent.com',
    tokenClient: null,
    syncDebounceTimer: null,
    cloudFileId: null,

    // 初始化 GIS SDK
    init() {
        const cachedToken = localStorage.getItem('google_access_token');
        const cachedExpiry = localStorage.getItem('google_token_expiry');
        const gateway = document.getElementById('google-auth-gateway');
        
        // 提前綁定鎖屏按鈕事件，確保按鈕在 SDK 載入前就能被點擊
        const gatewayLoginBtn = document.getElementById('btn-gateway-google-login');
        const gatewaySkipBtn = document.getElementById('btn-gateway-skip');

        if (gatewayLoginBtn) {
            gatewayLoginBtn.onclick = () => this.signIn();
        }
        if (gatewaySkipBtn) {
            gatewaySkipBtn.onclick = () => {
                if (gateway) gateway.style.display = 'none';
            };
        }

        // 核心安全阻擋：未登入時，一開機就立刻跳出登入鎖屏，不受 Google SDK 載入延遲的影響
        const hasValidSession = cachedToken && cachedExpiry && Date.now() < parseInt(cachedExpiry);
        if (hasValidSession) {
            if (gateway) gateway.style.display = 'none';
        } else {
            this.clearLocalSession();
            if (gateway) gateway.style.display = 'flex';
        }

        // 檢測 Google GSI SDK 載入狀態
        if (typeof google === 'undefined') {
            console.warn('Google GSI SDK 尚未載入完成，將啟動背景輪詢檢測...');
            const checkTimer = setInterval(() => {
                if (typeof google !== 'undefined') {
                    clearInterval(checkTimer);
                    this.initTokenClient();
                }
            }, 500); // 每 500ms 輪詢一次
            return;
        }
        
        this.initTokenClient();
    },

    // 抽離 Token Client 初始化
    initTokenClient() {
        if (this.tokenClient) return;
        try {
            this.tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: this.clientId,
                scope: 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email',
                callback: async (tokenResponse) => {
                    if (tokenResponse.error !== undefined) {
                        console.error('Google OAuth error:', tokenResponse.error);
                        alert('授權登入失敗：' + tokenResponse.error);
                        return;
                    }
                    
                    state.googleAccessToken = tokenResponse.access_token;
                    localStorage.setItem('google_access_token', tokenResponse.access_token);
                    localStorage.setItem('google_token_expiry', (Date.now() + 3500 * 1000).toString());
                    
                    // 登入成功，立刻隱藏鎖屏
                    const gateway = document.getElementById('google-auth-gateway');
                    if (gateway) gateway.style.display = 'none';

                    // 獲取用戶資料與進行首次同步
                    await this.fetchUserInfo();
                    await this.sync(false);
                }
            });

            // 讀取自動同步選項
            const autoSync = localStorage.getItem('google_auto_sync_enabled');
            if (autoSync !== null) {
                state.autoSyncEnabled = autoSync === 'true';
                const toggle = document.getElementById('setting-auto-sync');
                if (toggle) toggle.checked = state.autoSyncEnabled;
            }

            // 二次檢查快取登入狀態並進行啟動同步
            const cachedToken = localStorage.getItem('google_access_token');
            const cachedExpiry = localStorage.getItem('google_token_expiry');
            const cachedUser = localStorage.getItem('google_user');
            const cachedSyncTime = localStorage.getItem('google_last_sync_time');

            if (cachedToken && cachedExpiry && Date.now() < parseInt(cachedExpiry)) {
                state.googleAccessToken = cachedToken;
                if (cachedUser) state.googleUser = JSON.parse(cachedUser);
                if (cachedSyncTime) state.googleLastSyncTime = parseInt(cachedSyncTime);
                
                this.updateUI();
                setTimeout(() => this.sync(true), 1500);
            }
        } catch (e) {
            console.error('初始化 Google OAuth Client 失敗: ', e);
        }
    },

    // 登入 Google
    signIn() {
        if (!this.tokenClient) {
            this.initTokenClient();
        }
        if (this.tokenClient) {
            this.tokenClient.requestAccessToken({ prompt: 'consent' });
        } else {
            alert('Google API 載入中，請稍候再試。若一直載入失敗，請確認您的網路連線是否通暢。');
        }
    },

    // 登出 Google
    signOut() {
        if (state.googleAccessToken) {
            google.accounts.oauth2.revoke(state.googleAccessToken, () => {
                console.log('Google Access Token 已撤銷');
            });
        }
        this.clearLocalSession();
        this.updateUI();
        alert('雲端帳號已登出，同步已關閉。');

        // 重新顯示登入鎖屏
        const gateway = document.getElementById('google-auth-gateway');
        if (gateway) gateway.style.display = 'flex';
    },

    // 清理本地 Session
    clearLocalSession() {
        state.googleAccessToken = null;
        state.googleUser = null;
        state.googleLastSyncTime = null;
        this.cloudFileId = null;
        localStorage.removeItem('google_access_token');
        localStorage.removeItem('google_token_expiry');
        localStorage.removeItem('google_user');
        localStorage.removeItem('google_last_sync_time');
    },

    // 獲取 Google 用戶頭像與資訊
    async fetchUserInfo() {
        if (!state.googleAccessToken) return;
        try {
            const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
                headers: { 'Authorization': `Bearer ${state.googleAccessToken}` }
            });
            if (res.ok) {
                const info = await res.json();
                state.googleUser = {
                    name: info.name,
                    email: info.email,
                    picture: info.picture
                };
                localStorage.setItem('google_user', JSON.stringify(state.googleUser));
                this.updateUI();
            }
        } catch (e) {
            console.error('獲取 Google 用戶資料失敗: ', e);
        }
    },

    // 更新 UI 面板狀態
    updateUI() {
        const unauthPanel = document.getElementById('sync-status-unauthenticated');
        const authPanel = document.getElementById('sync-status-authenticated');
        const infoDetails = document.getElementById('sync-info-details');
        
        if (!unauthPanel || !authPanel) return;

        if (state.googleAccessToken && state.googleUser) {
            unauthPanel.style.display = 'none';
            authPanel.style.display = 'flex';
            if (infoDetails) infoDetails.style.display = 'block';

            document.getElementById('google-user-avatar').src = state.googleUser.picture || '';
            document.getElementById('google-user-name').textContent = state.googleUser.name || 'Google 使用者';
            document.getElementById('google-user-email').textContent = state.googleUser.email || '';
            
            const lastSync = document.getElementById('google-last-sync-time');
            if (lastSync) {
                lastSync.textContent = state.googleLastSyncTime ? 
                    new Date(state.googleLastSyncTime).toLocaleString('zh-TW', { hour12: false }) : '無記錄';
            }
        } else {
            unauthPanel.style.display = 'flex';
            authPanel.style.display = 'none';
            if (infoDetails) infoDetails.style.display = 'none';
        }
    },

    // 尋找備份檔案
    async findBackupFile() {
        try {
            const res = await fetch('https://www.googleapis.com/drive/v3/files?q=name=\'aethercards_backup.json\'&spaces=appDataFolder&fields=files(id,name,modifiedTime)', {
                headers: { 'Authorization': `Bearer ${state.googleAccessToken}` }
            });
            
            if (res.status === 401) {
                // Token 過期，觸發重新授權
                this.handleTokenExpired();
                return null;
            }

            if (res.ok) {
                const data = await res.json();
                if (data.files && data.files.length > 0) {
                    this.cloudFileId = data.files[0].id;
                    return data.files[0].id;
                }
            }
            return null;
        } catch (e) {
            console.error('查詢 Google Drive 備份檔案失敗: ', e);
            return null;
        }
    },

    // 下載雲端備份
    async downloadBackup(fileId) {
        try {
            const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
                headers: { 'Authorization': `Bearer ${state.googleAccessToken}` }
            });
            if (res.ok) {
                return await res.json();
            }
            return null;
        } catch (e) {
            console.error('下載雲端資料失敗: ', e);
            return null;
        }
    },

    // 上傳本地資料至雲端
    async uploadBackup(fileId = null) {
        try {
            // 組裝 IndexedDB 數據
            const backupData = {
                version: 1,
                lastUpdated: parseInt(localStorage.getItem('aethercards_local_last_updated') || Date.now().toString()),
                exportTime: Date.now(),
                streakDays: state.streakDays,
                decks: await AetherDB.getAllDecks(),
                cards: []
            };

            const cardsLists = await Promise.all(backupData.decks.map(d => AetherDB.getCardsByDeck(d.id)));
            backupData.cards = cardsLists.flat();

            const jsonContent = JSON.stringify(backupData);

            let res;
            if (fileId) {
                // 1. PATCH 覆蓋更新現有檔案
                res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
                    method: 'PATCH',
                    headers: {
                        'Authorization': `Bearer ${state.googleAccessToken}`,
                        'Content-Type': 'application/json'
                    },
                    body: jsonContent
                });
            } else {
                // 2. POST 新建檔案 (AppDataFolder)
                const metadata = {
                    name: 'aethercards_backup.json',
                    parents: ['appDataFolder']
                };
                const boundary = 'AetherCardsSyncBoundary';
                const multipartRequestBody =
                    `--${boundary}\r\n` +
                    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
                    JSON.stringify(metadata) + '\r\n' +
                    `--${boundary}\r\n` +
                    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
                    jsonContent + '\r\n' +
                    `--${boundary}--`;

                res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${state.googleAccessToken}`,
                        'Content-Type': `multipart/related; boundary=${boundary}`
                    },
                    body: multipartRequestBody
                });
            }

            if (res.ok) {
                const responseData = await res.json();
                this.cloudFileId = responseData.id || this.cloudFileId;
                state.googleLastSyncTime = Date.now();
                localStorage.setItem('google_last_sync_time', state.googleLastSyncTime.toString());
                
                // 本地同步時間對齊
                localStorage.setItem('aethercards_local_last_updated', backupData.lastUpdated.toString());
                
                this.updateUI();
                return true;
            }
            return false;
        } catch (e) {
            console.error('上傳備份失敗: ', e);
            return false;
        }
    },

    // 雙向同步核心邏輯
    async sync(silent = false) {
        if (!state.googleAccessToken) return;
        
        try {
            if (!silent) {
                // 在 UI 上加入載入提示
                const syncBtn = document.getElementById('btn-google-sync-now');
                if (syncBtn) {
                    syncBtn.disabled = true;
                    syncBtn.textContent = '正在同步...';
                }
            }

            // 1. 尋找雲端檔案
            const fileId = await this.findBackupFile();
            
            // 2. 獲取本地最近更新時間戳
            const localLastUpdated = parseInt(localStorage.getItem('aethercards_local_last_updated') || '0');

            // 3. 分流處理
            if (!fileId) {
                // 雲端無檔案，直接將本地上傳
                const ok = await this.uploadBackup();
                if (ok && !silent) alert('雲端備份初始化成功，本地字卡已同步備份至 Google Drive！');
            } else {
                // 雲端有檔案，下載並比對
                const cloudData = await this.downloadBackup(fileId);
                
                if (cloudData) {
                    const cloudLastUpdated = cloudData.lastUpdated || 0;

                    if (cloudLastUpdated > localLastUpdated) {
                        // 雲端資料較新 ➔ 下載還原
                        
                        // 智慧型靜默還原：如果本地完全未編輯過（時間戳為 0，如剛初始化的新設備）或本地無資料
                        const localDecksCount = (await AetherDB.getAllDecks()).length;
                        if (localLastUpdated === 0 || localDecksCount === 0) {
                            await this.restoreCloudData(cloudData);
                            return;
                        }

                        // 本地有修改過才提示用戶覆蓋或上傳
                        const confirmRestore = confirm(`偵測到您在 Google Drive 雲端有更新的單字卡備份！\n\n雲端更新時間: ${new Date(cloudLastUpdated).toLocaleString()}\n本地更新時間: ${new Date(localLastUpdated).toLocaleString()}\n\n是否將雲端的 ${cloudData.decks.length} 個字卡夾與 ${cloudData.cards.length} 張字卡「還原覆蓋」到這台設備上？\n(注意：這將會覆蓋您這台設備目前的資料)`);
                        
                        if (confirmRestore) {
                            await this.restoreCloudData(cloudData);
                        } else {
                            // 如果用戶取消了，可以選擇將本地資料強制覆蓋雲端
                            const uploadNew = confirm('是否改為將此裝置的本地資料「上傳覆蓋」雲端？');
                            if (uploadNew) {
                                this.updateLocalTimestamp();
                                await this.uploadBackup(fileId);
                                if (!silent) alert('此裝置的本地單字卡已覆蓋更新至雲端！');
                            }
                        }
                    } else if (localLastUpdated > cloudLastUpdated) {
                        // 本地資料較新 ➔ 自動靜默上傳更新雲端
                        await this.uploadBackup(fileId);
                        if (!silent) alert('雲端備份更新成功！已將最新字卡上傳至 Google Drive。');
                    } else {
                        // 資料完全一致
                        state.googleLastSyncTime = Date.now();
                        localStorage.setItem('google_last_sync_time', state.googleLastSyncTime.toString());
                        this.updateUI();
                        if (!silent) alert('資料已是最新狀態，無需同步！');
                    }
                }
            }
        } catch (e) {
            console.error('同步失敗: ', e);
            if (!silent) alert('雲端同步失敗，請檢查網路連線或稍後重試。');
        } finally {
            if (!silent) {
                const syncBtn = document.getElementById('btn-google-sync-now');
                if (syncBtn) {
                    syncBtn.disabled = false;
                    syncBtn.textContent = '立即同步';
                }
            }
        }
    },

    // 還原雲端數據到本地 IndexedDB
    async restoreCloudData(cloudData) {
        try {
            // 清理本地舊資料
            await AetherDB.clearAllData();
            
            // 寫入新資料
            const deckPromises = cloudData.decks.map(d => AetherDB.saveDeck(d));
            const cardPromises = AetherDB.saveCardsBatch(cloudData.cards);
            await Promise.all([...deckPromises, cardPromises]);
            
            // 還原連勝天數
            if (cloudData.streakDays) {
                localStorage.setItem('streakDays', cloudData.streakDays.toString());
                state.streakDays = cloudData.streakDays;
            }

            // 更新本地與雲端的上次同步記錄
            localStorage.setItem('aethercards_local_last_updated', cloudData.lastUpdated.toString());
            state.googleLastSyncTime = Date.now();
            localStorage.setItem('google_last_sync_time', state.googleLastSyncTime.toString());

            alert('雲端單字卡資料已成功還原至此設備！網頁將自動重新整理以載入最新字卡。');
            window.location.reload();
        } catch (e) {
            console.error('寫入雲端還原資料失敗: ', e);
            alert('還原雲端資料寫入本地 IndexedDB 失敗，請重試。');
        }
    },

    // 手動更新本地時間戳，確保本地數據被判定為「最新」
    updateLocalTimestamp() {
        const now = Date.now();
        localStorage.setItem('aethercards_local_last_updated', now.toString());
    },

    // 處理 Token 過期
    handleTokenExpired() {
        console.warn('Google 存取權限已過期');
        this.clearLocalSession();
        this.updateUI();
        // 靜默嘗試重新獲取，或提示登入
        if (confirm('您的 Google 雲端連線已過期，請點擊確定以重新驗證帳號。')) {
            this.signIn();
        }
    },

    // 防抖自動同步 (當 IndexedDB 更新時被 Hook 調用)
    triggerDebounceSync() {
        if (!state.googleAccessToken || !state.autoSyncEnabled) return;
        
        // 更新本地更新時間戳
        this.updateLocalTimestamp();

        if (this.syncDebounceTimer) clearTimeout(this.syncDebounceTimer);
        this.syncDebounceTimer = setTimeout(() => {
            console.log('背景自動同步觸發...');
            this.sync(true); // 靜默背景同步
        }, 3000); // 3秒防抖
    }
};

// --- 11. SPA 頁面路由切換系統 ---
const AppRouter = {
    init() {
        const buttons = document.querySelectorAll('[data-view]');
        buttons.forEach(btn => {
            btn.onclick = () => {
                const view = btn.dataset.view;
                this.navigateTo(view);
            };
        });

        // 綁定返回按鈕
        document.getElementById('btn-back-to-decks').onclick = () => this.navigateTo('decks');
        document.getElementById('btn-cancel-edit').onclick = () => this.navigateTo('deck-detail', state.activeDeckId);
        document.getElementById('btn-cancel-import').onclick = () => this.navigateTo('deck-detail', state.activeDeckId);
        
        // 複習退出
        document.getElementById('btn-quit-study').onclick = () => {
            if (confirm('確定要退出複習模式嗎？目前的學習進度將不會被完整寫入紀錄中。')) {
                this.navigateTo('deck-detail', state.activeDeckId);
            }
        };

        // 測驗退出
        document.getElementById('btn-quit-quiz').onclick = () => {
            if (confirm('確定要退出拼寫測驗嗎？這將不會記錄最終成績。')) {
                this.navigateTo('deck-detail', state.activeDeckId);
            }
        };

        // 配對退出
        document.getElementById('btn-quit-match').onclick = () => {
            if (confirm('確定要退出配對遊戲嗎？這將不會記錄最終成績。')) {
                this.navigateTo('deck-detail', state.activeDeckId);
            }
        };
    },

    navigateTo(viewName, params = null) {
        state.currentView = viewName;
        
        // 切換 Active View DOM ( SPA 路由過渡)
        document.querySelectorAll('.app-view').forEach(v => {
            v.classList.remove('active');
        });
        
        const targetView = document.getElementById(`view-${viewName}`);
        if (targetView) targetView.classList.add('active');

        // 更新 Sidebar / Mobile Nav 的按鈕狀態
        document.querySelectorAll('[data-view]').forEach(btn => {
            if (btn.dataset.view === viewName) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        // 路由觸發特定初始化
        if (viewName === 'dashboard') {
            this.loadDashboard();
        } else if (viewName === 'decks') {
            this.loadDecksManager();
        } else if (viewName === 'deck-detail' && params) {
            this.loadDeckDetail(params);
        } else if (viewName === 'creator') {
            // params 代表是否為「編輯模式（傳入字卡夾物件）」
            EditorManager.initEditor(params);
        } else if (viewName === 'study') {
            // params 代表要複習的單字卡陣列
            StudySessionManager.init(params);
        } else if (viewName === 'quiz') {
            // params 代表要測驗的單字卡陣列
            QuizSessionManager.init(params);
        } else if (viewName === 'match') {
            // params 代表要進行連連看配對的單字卡陣列
            MatchGameManager.init(params);
        }
        
        // 滾動回到頂端
        window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    loadDashboard() {
        AetherDB.getAllDecks().then(decks => {
            // 更新統計
            document.getElementById('stats-total-cards').textContent = '0';
            document.getElementById('stats-mastered-cards').textContent = '0';
            document.getElementById('stats-total-reviews').textContent = '0';

            const listContainer = document.getElementById('dashboard-decks-list');
            listContainer.innerHTML = '';

            if (decks.length === 0) {
                listContainer.innerHTML = `
                    <div class="empty-state">
                        <p>尚未建立字卡夾，立即點擊「新建字卡夾」開始您的 AI 單字學習之旅吧！</p>
                    </div>
                `;
                return;
            }

            let grandTotalCards = 0;
            let grandMasteredCards = 0;
            let grandTotalReviews = 0;

            // 計算所有卡片數量與掌握度
            const promises = decks.map(deck => {
                return AetherDB.getCardsByDeck(deck.id).then(cards => {
                    const total = cards.length;
                    const mastered = cards.filter(c => c.mastered).length;
                    const reviews = cards.reduce((sum, c) => sum + (c.reviews || 0), 0);
                    
                    grandTotalCards += total;
                    grandMasteredCards += mastered;
                    grandTotalReviews += reviews;

                    const percent = total > 0 ? Math.round((mastered / total) * 100) : 0;
                    
                    // 渲染字卡夾卡片
                    const card = document.createElement('div');
                    card.className = `glass-card deck-card border-glow theme-${deck.theme || 'grad-aurora'}`;
                    card.onclick = () => this.navigateTo('deck-detail', deck.id);
                    
                    card.innerHTML = `
                        <div class="deck-theme-bar" style="background: var(--${deck.theme || 'grad-aurora'})"></div>
                        <div class="deck-info">
                            <h3>${deck.name}</h3>
                            <p>${deck.desc || '無描述'}</p>
                        </div>
                        <div class="deck-footer">
                            <span class="deck-count-badge">${total} 張字卡</span>
                            <div class="deck-mastery">
                                <span class="mastery-label">掌握度 ${percent}%</span>
                                <div class="mastery-progress-track">
                                    <div class="mastery-progress-bar" style="width: ${percent}%; background: var(--${deck.theme || 'grad-aurora'})"></div>
                                </div>
                            </div>
                        </div>
                    `;
                    listContainer.appendChild(card);
                });
            });

            Promise.all(promises).then(() => {
                document.getElementById('stats-total-cards').textContent = grandTotalCards;
                document.getElementById('stats-mastered-cards').textContent = grandMasteredCards;
                document.getElementById('stats-total-reviews').textContent = grandTotalReviews;
            });
        });
    },

    loadDecksManager() {
        AetherDB.getAllDecks().then(decks => {
            const listContainer = document.getElementById('manager-decks-list');
            listContainer.innerHTML = '';

            if (decks.length === 0) {
                listContainer.innerHTML = `
                    <div class="empty-state">
                        <p>尚未建立字卡夾，點擊右上角「新增字卡夾」手動或批次貼上單字吧！</p>
                    </div>
                `;
                return;
            }

            decks.forEach(deck => {
                AetherDB.getCardsByDeck(deck.id).then(cards => {
                    const total = cards.length;
                    const mastered = cards.filter(c => c.mastered).length;
                    const percent = total > 0 ? Math.round((mastered / total) * 100) : 0;
                    
                    const card = document.createElement('div');
                    card.className = `glass-card deck-card border-glow theme-${deck.theme || 'grad-aurora'}`;
                    card.onclick = () => this.navigateTo('deck-detail', deck.id);
                    
                    card.innerHTML = `
                        <div class="deck-theme-bar" style="background: var(--${deck.theme || 'grad-aurora'})"></div>
                        <div class="deck-info">
                            <h3>${deck.name}</h3>
                            <p>${deck.desc || '無描述'}</p>
                        </div>
                        <div class="deck-footer">
                            <span class="deck-count-badge">${total} 張字卡</span>
                            <div class="deck-mastery">
                                <span class="mastery-label">掌握度 ${percent}%</span>
                                <div class="mastery-progress-track">
                                    <div class="mastery-progress-bar" style="width: ${percent}%; background: var(--${deck.theme || 'grad-aurora'})"></div>
                                </div>
                            </div>
                        </div>
                    `;
                    listContainer.appendChild(card);
                });
            });
        });
    },

    loadDeckDetail(deckId) {
        state.activeDeckId = deckId;

        // 讀取該字卡夾詳情
        AetherDB.getAllDecks().then(decks => {
            const deck = decks.find(d => d.id === deckId);
            if (!deck) return;

            document.getElementById('detail-deck-name').textContent = deck.name;
            document.getElementById('detail-deck-desc').textContent = deck.desc || '無描述說明';
            
            // 更新漸層頭部 Theme
            const panel = document.getElementById('detail-header-panel');
            panel.className = `detail-header-card glass-card border-glow theme-${deck.theme || 'grad-aurora'}`;
            panel.querySelector('.deck-theme-bar')?.remove(); // 清除舊條
            const bar = document.createElement('div');
            bar.className = 'deck-theme-bar';
            bar.style.background = `var(--${deck.theme || 'grad-aurora'})`;
            panel.appendChild(bar);

            // 載入字卡清單
            AetherDB.getCardsByDeck(deckId).then(cards => {
                document.getElementById('detail-cards-count').textContent = cards.length;
                
                const listContainer = document.getElementById('deck-cards-list');
                listContainer.innerHTML = '';

                if (cards.length === 0) {
                    listContainer.innerHTML = `
                        <div class="empty-state">
                            <p>此字卡夾中還沒有單字。請點擊上方按鈕「編輯/新增字卡」或「批次匯入單字」開始新增！</p>
                        </div>
                    `;
                    
                    // 禁用學習測驗按鈕
                    document.getElementById('btn-start-study').disabled = true;
                    document.getElementById('btn-start-quiz').disabled = true;
                    return;
                }

                // 啟用學習測驗按鈕
                document.getElementById('btn-start-study').disabled = false;
                document.getElementById('btn-start-quiz').disabled = false;

                // 綁定複習與測驗按鈕事件 (傳入對應卡片陣列)
                document.getElementById('btn-start-study').onclick = () => this.navigateTo('study', cards);
                document.getElementById('btn-start-quiz').onclick = () => QuizSelectModalManager.show(cards);
                document.getElementById('btn-edit-deck-structure').onclick = () => this.navigateTo('creator', deck);

                // 渲染單字卡列表
                cards.forEach(card => {
                    const cardDiv = document.createElement('div');
                    cardDiv.className = 'glass-card word-item-card border-glow';
                    
                    const badgeClass = card.mastered ? 'badge-mastered' : 'badge-learning';
                    const badgeText = card.mastered ? '已掌握' : '學習中';

                    cardDiv.innerHTML = `
                        <span class="master-badge ${badgeClass}">${badgeText}</span>
                        <div class="card-item-header">
                            <div class="card-item-thumbnail">
                                ${card.image ? `<img src="${card.image}" alt="縮圖">` : `
                                    <div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; background:rgba(255,255,255,0.03); color:var(--text-muted)">
                                        <svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
                                    </div>
                                `}
                            </div>
                            <div class="card-item-title-box">
                                <h4>${card.front}</h4>
                                <p>${card.hint ? `音標/提示: [${card.hint}]` : '無發音提示'}</p>
                            </div>
                        </div>
                        <div class="card-item-body">
                            <div class="definition-text">${card.back}</div>
                            ${card.example ? `<div class="example-text">例：${card.example}</div>` : ''}
                        </div>
                    `;
                    listContainer.appendChild(cardDiv);
                });
            });
        });
    }
};

// --- 12. 應用程式種子資料 (Initial Seeds) ---
const Seeds = {
    hasDecks() {
        return AetherDB.getAllDecks().then(decks => decks.length > 0);
    },

    seedSampleData() {
        const sampleDeck = {
            id: 'deck_sample_1',
            name: '🌟 多益核心必背 (AI 示範)',
            desc: '收錄多益考試最常見的高頻核心單字，包含全自動 AI 配圖展示。',
            theme: 'grad-aurora',
            createdAt: Date.now()
        };

        const sampleCards = [
            {
                id: 'card_sample_11',
                deckId: 'deck_sample_1',
                front: 'collaboration',
                back: 'n. 合作，協同工作',
                hint: 'kəˌlæb.əˈreɪ.ʃən',
                example: 'Success relies on close collaboration between teams.',
                image: null,
                mastered: false,
                reviews: 0,
                createdAt: Date.now()
            },
            {
                id: 'card_sample_12',
                deckId: 'deck_sample_1',
                front: 'innovative',
                back: 'adj. 創新的，革新的',
                hint: 'ˈɪn.ə.veɪ.tɪv',
                example: 'She proposed an innovative solution to the problem.',
                image: null,
                mastered: false,
                reviews: 0,
                createdAt: Date.now()
            },
            {
                id: 'card_sample_13',
                deckId: 'deck_sample_1',
                front: 'negotiate',
                back: 'v. 談判，協商',
                hint: 'nəˈɡoʊ.ʃi.eɪt',
                example: 'We need to negotiate a better contract with the supplier.',
                image: null,
                mastered: false,
                reviews: 0,
                createdAt: Date.now()
            }
        ];

        // 批次寫入字卡夾
        AetherDB.saveDeck(sampleDeck)
            .then(() => {
                // 為種子單字卡在背景搜尋 AI 照片，讓使用者一打開就有 WOW 的體驗！
                const promises = sampleCards.map(card => {
                    const searchUrl = ImageEngine.getAiSearchUrl(card.front);
                    return ImageEngine.compressImageFromUrl(searchUrl)
                        .then(base64 => {
                            card.image = base64;
                        })
                        .catch(err => {
                            console.warn(`種子單字 [${card.front}] AI 配圖失敗（將無配圖存入）：`, err);
                        })
                        .finally(() => {
                            return AetherDB.saveCard(card);
                        });
                });
                return Promise.all(promises);
            })
            .then(() => {
                AppRouter.loadDashboard();
            });
    }
};

// --- 13. 系統初始化與事件綁定 ---
window.addEventListener('DOMContentLoaded', () => {
    // 1. 初始化 IndexedDB 數據庫
    AetherDB.init()
        .then(() => {
            // 2. 初始化學習連勝
            StreakManager.init();
            
            // 3. 初始化 SPA 路由器
            AppRouter.init();
            
            // 4. 載入首頁儀表板
            AppRouter.navigateTo('dashboard');

            // 5. 如果是全新開啟，載入 AI 示範種子字卡夾
            Seeds.hasDecks().then(exists => {
                if (!exists) {
                    Seeds.seedSampleData();
                }
            });

            // 5.5 初始化 Google 雲端同步系統
            setTimeout(() => {
                CloudSyncManager.init();
            }, 100);
        })
        .catch(err => {
            alert('AetherDB 啟動失敗，請確認瀏覽器支援 IndexedDB：' + err);
        });

    // 6. 點擊「新建字卡夾」Dialog 彈窗
    const deckModal = document.getElementById('deck-modal');
    const openModalBtn1 = document.getElementById('btn-create-deck');
    const openModalBtn2 = document.getElementById('btn-create-deck-dash');
    const closeModalBtn = document.getElementById('btn-close-deck-modal');
    const modalForm = document.getElementById('deck-modal-form');

    const showModal = () => {
        deckModal.classList.add('active');
        document.getElementById('deck-name-input').value = '';
        document.getElementById('deck-desc-input').value = '';
        document.getElementById('deck-name-input').focus();
    };

    const hideModal = () => {
        deckModal.classList.remove('active');
    };

    if (openModalBtn1) openModalBtn1.onclick = showModal;
    if (openModalBtn2) openModalBtn2.onclick = showModal;
    if (closeModalBtn) closeModalBtn.onclick = hideModal;
    
    // 點擊彈窗外部關閉
    deckModal.onclick = (e) => {
        if (e.target === deckModal) hideModal();
    };

    // 新增字卡夾表單提交 -> 直接進入編輯器
    modalForm.onsubmit = (e) => {
        e.preventDefault();
        const name = document.getElementById('deck-name-input').value.trim();
        const desc = document.getElementById('deck-desc-input').value.trim();
        
        if (!name) return;

        hideModal();
        
        // 進入手動編輯介面
        state.activeDeckId = 'deck_' + Date.now();
        const tempDeck = {
            id: state.activeDeckId,
            name: name,
            desc: desc,
            theme: 'grad-aurora'
        };
        AppRouter.navigateTo('creator', tempDeck);
    };

    // 7. 編輯器自訂漸層主題點選事件
    document.getElementById('deck-theme-picker').onclick = (e) => {
        const dot = e.target.closest('.theme-dot');
        if (!dot) return;

        document.querySelectorAll('.theme-dot').forEach(d => d.classList.remove('active'));
        dot.classList.add('active');
    };

    // 8. 編輯器「新增一行單字」按鈕
    document.getElementById('btn-editor-add-row').onclick = () => {
        EditorManager.addRow();
        // 自動聚焦在剛新增的那一行的正面欄位
        setTimeout(() => {
            const terms = document.querySelectorAll('.input-row-term');
            terms[terms.length - 1].focus();
        }, 50);
    };

    // 9. 編輯器「儲存字卡夾」按鈕
    document.getElementById('btn-save-deck').onclick = () => {
        EditorManager.saveDeck();
    };

    // 10. 批次匯入解析預覽按鈕
    document.getElementById('btn-preview-import').onclick = () => {
        ImporterManager.parseText();
    };

    // 11. 批次匯入確認執行按鈕
    document.getElementById('btn-execute-import').onclick = () => {
        ImporterManager.executeImport();
    };

    // 12. 複習模式「需複習」與「已掌握」大按鈕
    document.getElementById('btn-study-again').onclick = () => {
        StudySessionManager.evaluate(false);
    };
    
    document.getElementById('btn-study-gotit').onclick = () => {
        StudySessionManager.evaluate(true);
    };

    // 複習模式一鍵靜音/音效切換
    document.getElementById('btn-study-sound').onclick = () => {
        state.soundEnabled = !state.soundEnabled;
        const soundBtn = document.getElementById('btn-study-sound');
        const checkbox = document.getElementById('setting-sound-enabled');
        
        checkbox.checked = state.soundEnabled;
        
        if (state.soundEnabled) {
            soundBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" class="sound-icon-on"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
        } else {
            soundBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" class="sound-icon-off"><path fill="currentColor" d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.21.05-.42.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`;
        }
    };

    // 13. 拼寫測驗提交答案表單與下一題
    document.getElementById('quiz-submit-form').onsubmit = (e) => {
        e.preventDefault();
        const btnNext = document.getElementById('btn-next-quiz');
        if (btnNext && btnNext.style.display !== 'none') {
            QuizSessionManager.nextQuestion();
        } else {
            QuizSessionManager.submitAnswer(e);
        }
    };

    document.getElementById('btn-next-quiz').onclick = () => {
        QuizSessionManager.nextQuestion();
    };

    // 測驗再挑戰一次與退出
    document.getElementById('btn-restart-quiz').onclick = () => {
        QuizSessionManager.init(state.quizSession.cards);
    };
    
    document.getElementById('btn-result-exit').onclick = () => {
        AppRouter.navigateTo('deck-detail', state.activeDeckId);
    };

    // 13.2 刪除與分享字卡夾按鈕事件
    const shareDeckBtn = document.getElementById('btn-share-deck');
    if (shareDeckBtn) {
        shareDeckBtn.onclick = () => {
            BackupEngine.exportSingleDeck(state.activeDeckId);
        };
    }

    const deleteDeckBtn = document.getElementById('btn-delete-deck');
    if (deleteDeckBtn) {
        deleteDeckBtn.onclick = () => {
            if (confirm('🚨 警告：您確定要永久刪除此字卡夾嗎？這將會刪除其包含的所有單字卡與本地 AI 圖片！此動作完全無法復原。')) {
                AetherDB.deleteDeck(state.activeDeckId).then(() => {
                    alert('字卡夾已成功刪除！');
                    AppRouter.navigateTo('dashboard');
                });
            }
        };
    }

    // 13.5 編輯器專用批次匯入事件
    const creatorImportModal = document.getElementById('creator-import-modal');
    const openCreatorImportBtn = document.getElementById('btn-creator-batch-import');
    const closeCreatorImportBtn = document.getElementById('btn-close-creator-import');
    const previewCreatorImportBtn = document.getElementById('btn-preview-creator-import');
    const executeCreatorImportBtn = document.getElementById('btn-execute-creator-import');

    let creatorParsedCards = []; // 用於存放臨時解析出來的卡片

    if (openCreatorImportBtn) {
        openCreatorImportBtn.onclick = () => {
            document.getElementById('creator-import-text').value = '';
            document.getElementById('creator-import-preview-box').style.display = 'none';
            executeCreatorImportBtn.disabled = true;
            executeCreatorImportBtn.style.opacity = '0.5';
            creatorParsedCards = [];
            creatorImportModal.classList.add('active');
            document.getElementById('creator-import-text').focus();
        };
    }

    if (closeCreatorImportBtn) {
        closeCreatorImportBtn.onclick = () => {
            creatorImportModal.classList.remove('active');
        };
    }

    if (creatorImportModal) {
        creatorImportModal.onclick = (e) => {
            if (e.target === creatorImportModal) creatorImportModal.classList.remove('active');
        };
    }

    // 點擊「解析預覽」
    if (previewCreatorImportBtn) {
        previewCreatorImportBtn.onclick = () => {
            const text = document.getElementById('creator-import-text').value;
            const separatorSelect = document.getElementById('creator-import-separator').value;
            
            if (!text.trim()) {
                alert('請貼上單字內容！');
                return;
            }

            const lines = text.split('\n');
            creatorParsedCards = [];

            lines.forEach(line => {
                if (!line.trim()) return;

                let front = '';
                let back = '';

                // 使用智慧型或特定分隔符解析
                if (separatorSelect === 'auto') {
                    const parsed = smartParseLine(line);
                    if (parsed) {
                        front = parsed.front;
                        back = parsed.back;
                    }
                } else {
                    let splitChar = ' - ';
                    if (separatorSelect === 'dash') splitChar = ' - ';
                    else if (separatorSelect === 'comma') splitChar = ',';
                    else if (separatorSelect === 'colon') splitChar = ':';
                    else if (separatorSelect === 'tab') splitChar = '\t';

                    // 相容全形與多空格
                    let parts = [];
                    if (separatorSelect === 'comma') {
                        parts = line.split(/[,，]/);
                    } else if (separatorSelect === 'colon') {
                        parts = line.split(/[:：]/);
                    } else if (separatorSelect === 'dash') {
                        parts = line.split(/[\-—]/);
                    } else {
                        parts = line.split(splitChar);
                    }

                    if (parts.length >= 2) {
                        front = parts[0].trim();
                        back = parts.slice(1).join(' ').trim();
                    } else {
                        front = line.trim();
                        back = '';
                    }
                    
                    // 額外清理
                    back = back.replace(/^[\s#＃|｜/／\-—:：,，]+/, '').trim();
                }

                if (front) {
                    creatorParsedCards.push({
                        front: front,
                        back: back
                    });
                }
            });

            // 渲染預覽表格
            const previewBox = document.getElementById('creator-import-preview-box');
            const previewTbody = document.getElementById('creator-import-preview-tbody');
            const previewCount = document.getElementById('creator-import-preview-count');
            
            previewTbody.innerHTML = '';
            
            if (creatorParsedCards.length === 0) {
                alert('無法解析任何單字，請檢查文字內容與分隔符號設定！');
                executeCreatorImportBtn.disabled = true;
                executeCreatorImportBtn.style.opacity = '0.5';
                previewBox.style.display = 'none';
                return;
            }

            const isTranslate = document.getElementById('creator-import-toggle-translate').checked;

            creatorParsedCards.forEach((c, idx) => {
                const tr = document.createElement('tr');
                tr.id = `import-preview-row-${idx}`;
                
                let backHtml = c.back;
                if (!backHtml) {
                    if (isTranslate) {
                        backHtml = '<span class="text-muted" style="font-style: italic;">🤖 AI 智慧翻譯中...</span>';
                    } else {
                        backHtml = '<span class="text-danger">（未設定）</span>';
                    }
                }

                tr.innerHTML = `
                    <td style="padding: 0.35rem; border-bottom: 1px solid var(--border-glass);"><strong>${c.front}</strong></td>
                    <td style="padding: 0.35rem; border-bottom: 1px solid var(--border-glass);" class="row-back-cell">${backHtml}</td>
                `;
                previewTbody.appendChild(tr);
            });

            previewCount.textContent = creatorParsedCards.length;
            previewBox.style.display = 'block';

            // 啟用「確認附加」按鈕
            executeCreatorImportBtn.disabled = false;
            executeCreatorImportBtn.style.opacity = '1';

            // 背景異步自動翻譯
            if (isTranslate) {
                creatorParsedCards.forEach(async (c, idx) => {
                    if (!c.back) {
                        // 翻譯至繁體中文
                        const translation = await translateText(c.front, 'zh-TW');
                        if (translation) {
                            c.back = translation;
                            const row = document.getElementById(`import-preview-row-${idx}`);
                            if (row) {
                                const backCell = row.querySelector('.row-back-cell');
                                if (backCell) {
                                    backCell.innerHTML = `<span style="color: var(--primary-glow); font-weight: 600;">✨ ${translation}</span>`;
                                }
                            }
                        } else {
                            c.back = '未填寫';
                            const row = document.getElementById(`import-preview-row-${idx}`);
                            if (row) {
                                const backCell = row.querySelector('.row-back-cell');
                                if (backCell) {
                                    backCell.innerHTML = '<span class="text-danger">未填寫</span>';
                                }
                            }
                        }
                    }
                });
            }
        };
    }

    // 點擊「確認附加」
    if (executeCreatorImportBtn) {
        executeCreatorImportBtn.onclick = () => {
            if (creatorParsedCards.length === 0) return;

            const isAutopilot = document.getElementById('creator-import-toggle-autopilot').checked;
            let parsedCount = 0;

            // 檢查目前編輯器中有沒有全空的行 (如果有的話在附加時可以清理掉)
            let emptyRowIds = EditorManager.rows
                .filter(r => !r.term.trim() && !r.definition.trim() && !r.image)
                .map(r => r.id);

            creatorParsedCards.forEach(c => {
                // 如果有空行，先將第一個空行從 DOM 中刪除
                if (emptyRowIds.length > 0) {
                    const emptyId = emptyRowIds.shift();
                    EditorManager.rows = EditorManager.rows.filter(r => r.id !== emptyId);
                    const oldCard = document.getElementById(`row-card-${emptyId}`);
                    if (oldCard) oldCard.remove();
                }

                const newId = 'card_' + Math.random().toString(36).substr(2, 9);
                const newRow = {
                    id: newId,
                    term: c.front,
                    definition: c.back || '未填寫',
                    hint: '',
                    example: '',
                    image: null,
                    isAiFetching: false
                };

                EditorManager.rows.push(newRow);
                EditorManager.renderRow(newRow);
                parsedCount++;

                // 如果啟用了 AI Autopilot，背景自動配圖，此時會直接在各行圖片區顯示正在搜圖提示
                if (isAutopilot) {
                    EditorManager.fetchAiImage(newId, 'search');
                }
            });

            if (parsedCount > 0) {
                alert(`成功解析並附加了 ${parsedCount} 個單字！`);
            }
            creatorImportModal.classList.remove('active');
        };
    }

    // 14. 設定頁：資料匯出與還原觸發
    document.getElementById('btn-export-data').onclick = () => {
        BackupEngine.exportAll();
    };

    const fileInput = document.getElementById('import-file-input');
    document.getElementById('btn-trigger-import').onclick = () => {
        fileInput.click();
    };
    
    fileInput.onchange = (e) => {
        if (e.target.files && e.target.files[0]) {
            BackupEngine.importAll(e.target.files[0]);
        }
    };

    // 14.1 Google 雲端同步事件綁定
    const googleLoginBtn = document.getElementById('btn-google-login');
    const googleLogoutBtn = document.getElementById('btn-google-logout');
    const googleSyncBtn = document.getElementById('btn-google-sync-now');
    const autoSyncToggle = document.getElementById('setting-auto-sync');

    if (googleLoginBtn) {
        googleLoginBtn.onclick = () => CloudSyncManager.signIn();
    }
    if (googleLogoutBtn) {
        googleLogoutBtn.onclick = () => CloudSyncManager.signOut();
    }
    if (googleSyncBtn) {
        googleSyncBtn.onclick = () => CloudSyncManager.sync(false);
    }
    if (autoSyncToggle) {
        autoSyncToggle.onchange = (e) => {
            state.autoSyncEnabled = e.target.checked;
            localStorage.setItem('google_auto_sync_enabled', state.autoSyncEnabled.toString());
            if (state.autoSyncEnabled && state.googleAccessToken) {
                CloudSyncManager.sync(true); // 背景自動同步一次
            }
        };
    }

    // 14.5 主介面：單個字卡夾分享與匯入觸發
    const singleFileInput = document.getElementById('import-single-file-input');
    const triggerImportSingleBtn = document.getElementById('btn-trigger-import-single');
    if (triggerImportSingleBtn && singleFileInput) {
        triggerImportSingleBtn.onclick = () => {
            singleFileInput.click();
        };

        singleFileInput.onchange = (e) => {
            if (e.target.files && e.target.files[0]) {
                BackupEngine.importSingleDeck(e.target.files[0]);
            }
        };
    }

    // 音效開關 Slider 同步
    document.getElementById('setting-sound-enabled').onchange = (e) => {
        state.soundEnabled = e.target.checked;
        const soundBtn = document.getElementById('btn-study-sound');
        
        if (state.soundEnabled) {
            soundBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" class="sound-icon-on"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>`;
        } else {
            soundBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" class="sound-icon-off"><path fill="currentColor" d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.21.05-.42.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>`;
        }
    };

    // 清除全部資料危險操作
    document.getElementById('btn-danger-clear').onclick = () => {
        if (confirm('🚨 警告：這將會刪除您所有的字卡夾、複習進度、連續天數統計，以及所有的 AI 插圖！此操作完全無法還原。確定要繼續嗎？')) {
            const doubleCheck = prompt('請在下方輸入「DELETE ALL」以確認此危險操作：');
            if (doubleCheck === 'DELETE ALL') {
                AetherDB.clearAllData().then(() => {
                    localStorage.clear();
                    alert('資料庫已完全清除。網頁將重新載入。');
                    window.location.reload();
                });
            } else {
                alert('驗證輸入錯誤，操作已取消！');
            }
        }
    };

    // 15. 字卡夾搜尋與單字卡搜尋即時過濾
    document.getElementById('decks-search').oninput = (e) => {
        const query = e.target.value.toLowerCase().trim();
        const deckCards = document.querySelectorAll('#manager-decks-list .deck-card');
        
        deckCards.forEach(card => {
            const name = card.querySelector('h3').textContent.toLowerCase();
            const desc = card.querySelector('p').textContent.toLowerCase();
            if (name.includes(query) || desc.includes(query)) {
                card.style.display = 'flex';
            } else {
                card.style.display = 'none';
            }
        });
    };

    document.getElementById('cards-search').oninput = (e) => {
        const query = e.target.value.toLowerCase().trim();
        const wordCards = document.querySelectorAll('#deck-cards-list .word-item-card');
        
        wordCards.forEach(card => {
            const front = card.querySelector('h4').textContent.toLowerCase();
            const back = card.querySelector('.definition-text').textContent.toLowerCase();
            const example = card.querySelector('.example-text')?.textContent.toLowerCase() || '';
            
            if (front.includes(query) || back.includes(query) || example.includes(query)) {
                card.style.display = 'flex';
            } else {
                card.style.display = 'none';
            }
        });
    };
});
