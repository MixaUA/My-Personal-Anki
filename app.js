let notebooks = JSON.parse(localStorage.getItem('scs_v16')) || [];
let currentIdx = null;
let trainingQueue = [];
let currentCardIdx = 0;
let totalCardsInSession = 0;

let speechSettings = JSON.parse(localStorage.getItem('scs_speech_profiles_v3')) || {
    gender: 'female',
    noiseThreshold: 20, silenceTimeout: 3,
    male: { rate: 0.9, pitch: 0.9, voiceURI: '' },
    female: { rate: 0.9, pitch: 1.0, voiceURI: '' }
};

// --- AUDIO COMPONENT (SPEECH ENGINE) ---
const SpeechEngine = {
    recognition: null, audioContext: null, analyser: null, stream: null, animationId: null,
    visualData: new Array(150).fill(0), 
    audioDataArray: null,
    silenceTimer: null,
    isListening: false, 
    lastSoundTime: 0,
    isStreamActive: false,
    ignoreResults: false,
    isEngineRunning: false, 
    sessionTranscript: "", 
    pttStartIndex: 0,      // Індекс результатів Google на момент натискання кнопки
    isPTTActive: false,    // Флаг того, що кнопка натиснута (Push-to-Talk)
    globalResultsCount: 0, // Загальна кількість результатів, яку ми бачили

    init() {
        if (this.recognition) return; 
        const SpeechReq = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechReq) return;
        
        this.recognition = new SpeechReq();
        this.recognition.lang = 'en-US';
        this.recognition.continuous = true; 
        this.recognition.interimResults = true;

        this.recognition.onresult = (e) => {
            // Завжди оновлюємо глобальний стан
            this.globalResultsCount = e.results.length;

            if (!this.isPTTActive || this.ignoreResults) return;
            
            let finalParts = [];
            let interim = "";

            // Зчитуємо тільки те, що було сказано ПІСЛЯ натискання
            for (let i = this.pttStartIndex; i < e.results.length; ++i) {
                if (!e.results[i]) continue;
                const transcript = e.results[i][0].transcript.trim();
                // Кожне слово обробляємо окремо для точності
                if (e.results[i].isFinal) {
                    finalParts.push(transcript);
                } else {
                    interim += transcript;
                }
            }

            this.sessionTranscript = finalParts.join(" ");
            
            const cleanText = (text) => {
                const words = text.toLowerCase().split(/\s+/);
                return words.filter((word, i) => {
                    // Видаляємо дублікати, що йдуть підряд
                    return word && (i === 0 || word !== words[i-1]);
                }).join(" ");
            };

            const fullText = (this.sessionTranscript + " " + interim).trim();
            const currentDisplay = cleanText(fullText);

            document.querySelectorAll('.speech-input').forEach(input => {
                input.value = currentDisplay;
                input.style.color = ''; // Скидаємо колір при новому ввіді
            });

            // Auto-stop logic
            clearTimeout(this.silenceTimer);
            if (currentDisplay.length > 0) {
                this.silenceTimer = setTimeout(() => {
                    if (this.isPTTActive) this.stopRecording();
                }, speechSettings.silenceTimeout * 1000);
            }
        };

        this.recognition.onstart = () => { 
            this.isEngineRunning = true; 
            console.log("Recognition: ACTIVE");
        };

        this.recognition.onend = () => {
            this.isEngineRunning = false;
            console.warn("Recognition: STOPPED.");
        };

        this.recognition.onerror = (e) => {
            if (e.error !== 'no-speech') console.error("Recognition ERROR:", e.error);
            // Форсуємо рестарт при критичних помилках мережі
            if (this.isStreamActive && (e.error === 'network' || e.error === 'aborted')) {
                setTimeout(() => {
                    if (!this.isEngineRunning) try { this.recognition.start(); } catch(err) {}
                }, 500);
            }
        };
    },

    // Вмикає залізо (мікрофон + візуалізація)
    async wakeUpHardware() {
        if (this.isStreamActive) return true;
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const source = this.audioContext.createMediaStreamSource(this.stream);
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            this.audioDataArray = new Uint8Array(this.analyser.frequencyBinCount);
            source.connect(this.analyser);
            this.isStreamActive = true;
            
            if (this.audioContext.state === 'suspended') await this.audioContext.resume();
            
            this.init();
            if (!this.isEngineRunning) try { this.recognition.start(); } catch(e) {}
            
            this.draw();
            return true;
        } catch (e) {
            console.error("Hardware Alert:", e);
            return false;
        }
    },

    // ТАП / КЛІК для перемикання запису
    async toggleRecording() {
        if (this.isPTTActive) {
            this.stopRecording();
            return;
        }

        const wasInactive = !this.isStreamActive;
        this.isPTTActive = true;
        
        const ok = await this.wakeUpHardware();
        if (!ok) { this.isPTTActive = false; return; }

        this.ignoreResults = false;
        this.sessionTranscript = "";
        clearTimeout(this.silenceTimer);

        if (wasInactive || !this.isEngineRunning) {
            document.querySelectorAll('.speech-input').forEach(i => i.placeholder = "Waking up... please wait 🎙️");
            const checkReady = setInterval(() => {
                if (this.isEngineRunning) {
                    clearInterval(checkReady);
                    if (this.isPTTActive) { 
                        this.pttStartIndex = this.globalResultsCount;
                        document.querySelectorAll('.speech-input').forEach(i => i.placeholder = "Listening...");
                    }
                }
            }, 100);
        } else {
            this.pttStartIndex = this.globalResultsCount;
            document.querySelectorAll('.mic-btn').forEach(btn => btn.classList.add('mic-active'));
            document.querySelectorAll('.speech-input').forEach(i => {
                i.value = "";
                i.placeholder = "Listening...";
            });
        }

        document.querySelectorAll('.mic-btn').forEach(btn => btn.classList.add('mic-active'));
        
        if (!this.isEngineRunning) {
            try { this.recognition.start(); } catch(e) {}
        }
    },

    stopRecording() {
        if (!this.isPTTActive) return;
        this.isPTTActive = false;
        clearTimeout(this.silenceTimer);
        document.querySelectorAll('.mic-btn').forEach(btn => btn.classList.remove('mic-active'));
        document.querySelectorAll('.speech-input').forEach(i => i.placeholder = "Tap to Speak...");
        
        try { this.recognition.stop(); } catch(e) {}
        
        const isTraining = document.getElementById('trainingOverlay').style.display === 'flex';
        if (isTraining) {
            const sInput = document.querySelector('.speech-input');
            if (sInput && sInput.value.trim() !== "") {
                checkVoiceAnswer();
            }
        }
    },

    draw() {
        const canvases = document.querySelectorAll('.audio-canvas');
        if (canvases.length === 0) return;

        if (this.audioDataArray) {
            this.analyser.getByteFrequencyData(this.audioDataArray);
        }

        let maxVol = this.audioDataArray ? Math.max(...this.audioDataArray) : 0;
        const actualThreshold = 100 + speechSettings.noiseThreshold;
        
        // --- UI HEALTH UPDATES ---
        const isHealthy = !this.isStreamActive || this.isEngineRunning;
        document.querySelectorAll('.mic-btn').forEach(btn => btn.disabled = !isHealthy);
        document.querySelectorAll('.speech-input').forEach(input => {
            if (!isHealthy) {
                input.placeholder = "Connecting...";
                if (!input.value) input.value = ""; // Force clear to show placeholder
            } else if (!this.isPTTActive) {
                input.placeholder = "Tap to Speak...";
            }
        });

        // Хвиля відображається завжди, коли є звук, але яскравіша при PTT
        let displayVal = (maxVol > actualThreshold) ? maxVol : 0;
        
        this.visualData.push(displayVal);
        this.visualData.shift();

        canvases.forEach(canvas => {
            const ctx = canvas.getContext('2d');
            const rect = canvas.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;

            if (canvas.width !== rect.width * devicePixelRatio) {
                canvas.width = rect.width * devicePixelRatio;
                canvas.height = rect.height * devicePixelRatio;
                ctx.scale(devicePixelRatio, devicePixelRatio);
            }

            const W = rect.width;
            const H = rect.height;
            ctx.clearRect(0, 0, W, H);
            
            ctx.beginPath();
            
            // СТАН ДВИГУНА:
            // 1. Якщо все завантажено, але розпізнавання "впало" (isEngineRunning: false) - малюємо ЧЕРВОНИМ ПУНКТИРОМ
            // 2. Якщо все ок, але ми не натиснули кнопку - СІРИМ (спокій)
            // 3. Якщо запис активний - ЧОРНИМ (активність)
            if (this.isStreamActive && !this.isEngineRunning) {
                ctx.strokeStyle = '#e74c3c'; // Червоний (Помилка/Перезапуск)
                ctx.setLineDash([2, 4]);
                ctx.lineWidth = 2;
            } else {
                ctx.strokeStyle = this.isPTTActive ? '#1a1a1a' : '#cccccc';
                ctx.lineWidth = this.isPTTActive ? 3 : 1.5;
                ctx.setLineDash([]);
            }
            
            ctx.lineJoin = 'round';
            
            for(let i=0; i < this.visualData.length; i++) {
                const x = (W / this.visualData.length) * i;
                const val = this.visualData[i];
                const h = (val / 255) * H;
                const y = (H - h) / 2;
                
                if(i === 0) ctx.moveTo(x, H / 2); 
                else {
                    if (val > 0) ctx.lineTo(x, y + (i % 2 === 0 ? h : 0));
                    else ctx.lineTo(x, H / 2);
                }
            }
            ctx.stroke();

            // Поріг малюємо пунктиром (червоним)
            const thresholdH = (actualThreshold / 255) * H;
            const thresholdYTop = (H - thresholdH) / 2;
            const thresholdYBottom = (H + thresholdH) / 2;
            ctx.beginPath();
            ctx.strokeStyle = '#ff0000'; 
            ctx.setLineDash([5, 5]);
            ctx.moveTo(0, thresholdYTop); ctx.lineTo(W, thresholdYTop);
            ctx.moveTo(0, thresholdYBottom); ctx.lineTo(W, thresholdYBottom);
            ctx.stroke();
            ctx.setLineDash([]);
        });

        if (this.isStreamActive) {
            this.animationId = requestAnimationFrame(() => this.draw());
        }
    },

    killAll() {
        this.isPTTActive = false;
        this.ignoreResults = true;
        if (this.recognition) try { this.recognition.stop(); } catch(e) {}
        this.isStreamActive = false;
        if(this.stream) this.stream.getTracks().forEach(t => t.stop());
        if(this.audioContext && this.audioContext.state !== 'closed') this.audioContext.close();
        cancelAnimationFrame(this.animationId);
        this.animationId = null;
    },

    levenshtein(a, b) {
        if (!a || !b) return 99;
        const clean = s => s.toLowerCase().trim().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g,"");
        const s1 = clean(a), s2 = clean(b);
        const m = [];
        for (let i = 0; i <= s1.length; i++) m[i] = [i];
        for (let j = 0; j <= s2.length; j++) m[0][j] = j;
        for (let i = 1; i <= s1.length; i++) {
            for (let j = 1; j <= s2.length; j++) {
                m[i][j] = s1[i-1] === s2[j-1] ? m[i-1][j-1] : Math.min(m[i-1][j-1], m[i][j-1], m[i-1][j]) + 1;
            }
        }
        return m[s1.length][s2.length];
    }
};

function checkVoiceAnswer() {
    const sInput = document.querySelector('.training-modal .speech-input'); 
    const input = sInput ? sInput.value : document.querySelector('.speech-input').value;
    const currentCard = trainingQueue[currentCardIdx];
    if(!input || !currentCard) return;
    
    const correct = currentCard.en || currentCard.code;
    const dist = SpeechEngine.levenshtein(input, correct);
    const limit = Math.floor(correct.length / 5) + 1; 

    if (dist <= limit) {
        flipCard();
    } else {
        document.querySelectorAll('.speech-input').forEach(el => {
            el.style.color = '#e74c3c';
            setTimeout(() => { el.style.color = ''; }, 1000);
        });
    }
}

// --- ЛОГІКА SM-2 ---
function startTraining() {
    const nb = notebooks[currentIdx];
    if(!nb.rows || nb.rows.length === 0) return alert("Порожньо!");
    
    document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
    document.getElementById('trainingTitle').innerText = nb.name;
    
    const now = new Date();
    trainingQueue = nb.rows.filter(card => !card.nextReview || new Date(card.nextReview) <= now);

    if(trainingQueue.length === 0) return alert("Все вивчено на сьогодні!");
    
    totalCardsInSession = trainingQueue.length;
    currentCardIdx = 0;
    
    updateProgress();
    showCard();
    openModal('trainingOverlay');
}

function updateProgress() {
    const left = trainingQueue.length;
    const elLeft = document.getElementById('cardsLeft');
    const elProg = document.getElementById('progressBar');
    if (elLeft) elLeft.innerText = left;
    if (elProg) {
        const percent = totalCardsInSession > 0 ? ((totalCardsInSession - left) / totalCardsInSession) * 100 : 0;
        elProg.style.width = percent + '%';
    }
}

function gradeCard(quality) {
    const card = trainingQueue[currentCardIdx];
    if (!card) return;
    
    if (!card.ease) card.ease = 2.5;
    if (!card.reps) card.reps = 0;
    if (!card.interval) card.interval = 0;

    if (quality < 3) { card.reps = 0; card.interval = 0; }
    else if (quality === 3) { 
        if (card.reps === 0) card.interval = 1; 
        else card.interval = Math.round(card.interval * card.ease);
        card.reps++;
    } else { card.interval = 4; card.reps++; }

    card.ease = Math.max(1.3, card.ease + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)));
    
    if (quality === 1) trainingQueue.push(trainingQueue.splice(currentCardIdx, 1)[0]);
    else if (quality === 2) {
        const moved = trainingQueue.splice(currentCardIdx, 1)[0];
        trainingQueue.splice(Math.min(trainingQueue.length, 2), 0, moved);
    } 
    else { 
        const d = new Date(); d.setDate(d.getDate() + card.interval);
        card.nextReview = d.toISOString();
        trainingQueue.splice(currentCardIdx, 1);
    }

    saveData();
    updateProgress();
    if (trainingQueue.length > 0) {
        if (currentCardIdx >= trainingQueue.length) currentCardIdx = 0;
        showCard();
    } else {
        alert("Чудово! Всі картки засвоєні.");
        closeAllModals();
    }
}

function toggleTheme() { document.body.dataset.theme = document.body.dataset.theme === 'dark' ? 'light' : 'dark'; }

function openModal(id) { 
    if(id === 'settingsOverlay') syncSettingsUI();
    document.getElementById(id).style.display = 'flex'; 
}

function closeAllModals() { 
    const isTr = document.getElementById('trainingOverlay').style.display === 'flex';
    if (isTr && trainingQueue.length > 0 && !confirm("Вийти?")) return;
    
    SpeechEngine.killAll();
    document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none'); 
    resetCard();
}

let _ttsTimeout = null;
function updateSpeechSetting(key, val) {
    if (key === 'rate' || key === 'pitch') {
        speechSettings[speechSettings.gender][key] = parseFloat(val);
    } else {
        speechSettings[key] = parseFloat(val);
    }
    
    const map = {'rate':'valRate', 'pitch':'valPitch', 'noiseThreshold':'valNoise', 'silenceTimeout':'valTimeout'};
    const el = document.getElementById(map[key]);
    if (el) el.innerText = val;
    localStorage.setItem('scs_speech_profiles_v3', JSON.stringify(speechSettings));
    
    if (key === 'rate' || key === 'pitch') {
        clearTimeout(_ttsTimeout);
        _ttsTimeout = setTimeout(() => { speakText("Voice test"); }, 300);
    }
}

function updateVoice(uri) {
    speechSettings[speechSettings.gender].voiceURI = uri;
    localStorage.setItem('scs_speech_profiles_v3', JSON.stringify(speechSettings));
    speakText("Voice test");
}

function setGender(g) {
    speechSettings.gender = g;
    localStorage.setItem('scs_speech_profiles_v3', JSON.stringify(speechSettings));
    syncSettingsUI(); 
    speakText("Voice test");
}

function populateVoices() {
    const select = document.getElementById('voiceSelect');
    if (!select) return;
    
    select.innerHTML = '<option value="">Відпустити на розсуд системи</option>';
    const voices = speechSynthesis.getVoices().filter(v => v.lang.startsWith('en'));
    
    voices.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.voiceURI;
        opt.textContent = `${v.name} (${v.lang})`;
        select.appendChild(opt);
    });
}

function syncSettingsUI() {
    const btnM = document.getElementById('btnMale');
    const btnF = document.getElementById('btnFemale');
    if (btnM) btnM.classList.toggle('active', speechSettings.gender === 'male');
    if (btnF) btnF.classList.toggle('active', speechSettings.gender === 'female');
    
    const profile = speechSettings[speechSettings.gender];
    const select = document.getElementById('voiceSelect');
    if (select) {
        select.value = profile.voiceURI || '';
    }
    
    const map = {
        'inputRate': 'rate', 'valRate': 'rate',
        'inputPitch': 'pitch', 'valPitch': 'pitch'
    };
    
    for (let id in map) {
        const el = document.getElementById(id);
        if (el) {
            const val = speechSettings[speechSettings.gender][map[id]];
            if (el.tagName === 'INPUT') el.value = val; else el.innerText = val;
        }
    }
    
    const globals = {
        'inputNoise': 'noiseThreshold', 'valNoise': 'noiseThreshold',
        'inputTimeout': 'silenceTimeout', 'valTimeout': 'silenceTimeout'
    };
    for (let id in globals) {
        const el = document.getElementById(id);
        if (el) {
            const val = speechSettings[globals[id]];
            if (el.tagName === 'INPUT') el.value = val; else el.innerText = val;
        }
    }
}

function speakText(text) {
    if (!text) return;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    const priority = speechSettings.gender === 'male' 
        ? ['UK English Male', 'David', 'Google UK English Male']
        : ['Google US English', 'UK English Female', 'Samantha', 'Karen', 'Google UK English Female'];

    const profile = speechSettings[speechSettings.gender];
    
    if (profile.voiceURI) {
        let exactVoice = voices.find(v => v.voiceURI === profile.voiceURI);
        if (exactVoice) utterance.voice = exactVoice;
    } 
    
    if (!utterance.voice) {
        let voice = voices.find(v => priority.some(p => v.name.includes(p)));
        if (voice) utterance.voice = voice;
    }
    
    utterance.rate = profile.rate;
    utterance.pitch = profile.pitch;
    
    speechSynthesis.speak(utterance);
}

function speakCurrentCard() {
    const card = trainingQueue[currentCardIdx];
    if (card) speakText(card.en || card.code || "");
}

function showCard() {
    resetCard();
    const card = trainingQueue[currentCardIdx];
    if (!card) return;
    document.getElementById('cardCode').innerText = card.code || "";
    document.getElementById('cardUA').innerText = card.ua || "";
    document.getElementById('cardEN').innerText = card.en || "";
    document.getElementById('cardTrans').innerText = card.trans ? `[${card.trans}]` : "";
    document.querySelectorAll('.speech-input').forEach(i => i.value = "");
    document.getElementById('speechPanel').style.display = 'flex';
}

function flipCard() {
    const card = document.getElementById('mainCard');
    if(!card.classList.contains('flipped')) {
        card.classList.add('flipped');
        document.getElementById('trainingActions').style.display = 'block';
        document.getElementById('speechPanel').style.display = 'none';
        document.getElementById('hintText').style.display = 'none';
        setTimeout(speakCurrentCard, 250); 
    }
}

function resetCard() {
    const card = document.getElementById('mainCard');
    if (card) card.classList.remove('flipped');
    const act = document.getElementById('trainingActions');
    if (act) act.style.display = 'none';
    const hint = document.getElementById('hintText');
    if (hint) hint.style.display = 'block';
}

function openAdmin(idx = null) {
    if(idx !== null) currentIdx = idx;
    const container = document.getElementById('adminCardsContainer');
    if (!container) return;
    container.innerHTML = '';
    notebooks[currentIdx].rows.forEach((row, index) => insertCardRow(row, index + 1));
    openModal('adminOverlay');
}

function insertCardRow(data = {ua:'', code:'', en:'', trans:''}, num = null) {
    const container = document.getElementById('adminCardsContainer');
    const n = num || container.children.length + 1;
    const card = document.createElement('div');
    card.className = 'admin-card';
    card.innerHTML = `<div class="card-header"><span class="card-num">#${n}</span><button onclick="this.closest('.admin-card').remove(); app.reindex();">🗑️</button></div>
        <input type="text" class="admin-input v-ua" placeholder="UA" value="${data.ua}">
        <input type="text" class="admin-input v-code" placeholder="Code" value="${data.code}">
        <input type="text" class="admin-input v-en" placeholder="EN" value="${data.en}">
        <input type="text" class="admin-input v-trans" placeholder="Trans" value="${data.trans}">`;
    container.appendChild(card);
}

function reindex() { document.querySelectorAll('.card-num').forEach((s, i) => s.innerText = `#${i+1}`); }
function saveAdminData() {
    notebooks[currentIdx].rows = Array.from(document.querySelectorAll('.admin-card')).map(c => ({
        ua: c.querySelector('.v-ua').value, code: c.querySelector('.v-code').value,
        en: c.querySelector('.v-en').value, trans: c.querySelector('.v-trans').value
    }));
    saveData(); alert("Збережено!");
}

function addNotebook(isL) {
    const val = prompt("Назва:");
    if(val) { notebooks.push({ name: val, linked: true, rows: [] }); saveData(); closeAllModals(); }
}

function addNotebookWithFile(e) {
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        notebooks.push({ name: file.name.replace('.json',''), linked: true, rows: JSON.parse(ev.target.result) });
        saveData();
        closeAllModals();
    }; reader.readAsText(file);
    e.target.value = '';
}

function updateFromFile(e) {
    const file = e.target.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { 
        notebooks[currentIdx].name = file.name.replace('.json','');
        notebooks[currentIdx].rows = JSON.parse(ev.target.result); 
        saveData(); 
        alert("Оновлено!"); 
        closeAllModals(); 
    };
    reader.readAsText(file);
    e.target.value = '';
}

function exportCurrentNotebook() {
    const b = new Blob([JSON.stringify(notebooks[currentIdx].rows, null, 2)], {type: 'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${notebooks[currentIdx].name}.json`; a.click();
}

function deleteCurrentNotebook() { if(confirm("Видалити?")) { notebooks.splice(currentIdx, 1); saveData(); closeAllModals(); } }
function saveData() { localStorage.setItem('scs_v16', JSON.stringify(notebooks)); renderShelf(); }

function renderShelf() {
    const shelf = document.getElementById('shelf');
    if (!shelf) return;
    shelf.innerHTML = `<div class="notebook hand-drawn-border" onclick="openModal('createOverlay')"><div class="notebook-cover" style="font-size:3rem; color:var(--accent)">+</div></div>`;
    notebooks.forEach((nb, i) => {
        const div = document.createElement('div');
        div.className = 'notebook hand-drawn-border';
        div.onclick = () => { currentIdx = i; document.getElementById('menuTitle').innerText = nb.name; document.getElementById('syncBtn').style.display = 'block'; openModal('menuOverlay'); };
        div.innerHTML = `<div class="notebook-cover">${nb.name}</div>`;
        shelf.appendChild(div);
    });
}

// ПРИВ'ЯЗКА ПОДІЙ TAP-TO-TALK
function initPTT() {
    document.querySelectorAll('.mic-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.preventDefault();
            SpeechEngine.toggleRecording();
        };
    });
}

window.app = {
    checkVoiceAnswer, updateSpeechSetting, setGender, updateVoice, toggleTheme, openModal, closeAllModals, openAdmin, insertCardRow, saveAdminData, addNotebook, addNotebookWithFile, updateFromFile, exportCurrentNotebook, deleteCurrentNotebook, reindex
};

speechSynthesis.onvoiceschanged = populateVoices;
populateVoices();
renderShelf();
initPTT();

// Auto-update footer year
const yearEl = document.getElementById('currentYear');
if (yearEl) yearEl.innerText = new Date().getFullYear();
