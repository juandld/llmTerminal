// AI text-to-speech playback for llmTerminal — classic script, shares
// global scope with app.js. Extracted (refactor 2026-06-10, app.js phase 4).

// AI TTS via server /tts endpoint (OpenAI tts-1 + disk cache). Chunked playback:
// splits long messages into ~1000-char segments at sentence boundaries, starts
// playing chunk 0 while the rest are fetched. YouTube-style buffer bar shows progress.
const TTS_CHUNK_TARGET = 1000;
const ttsBlobCache = new Map(); // text -> blob URL
const ttsPending = new Map();   // text -> Promise<blob URL>

function ttsTextKey(t){ return t.length + ":" + t.substring(0, 200) + "|" + t.substring(Math.max(0, t.length-100)); }

function splitTtsChunks(text){
  if(!text) return [];
  // Strip code blocks, image markdown, HTML tags, markdown formatting
  let t = text.replace(/```[\s\S]*?```/g, " [code block] ")
              .replace(/`[^`]+`/g, m => m.slice(1,-1))  // inline code: keep text
              .replace(/!\[.*?\]\(.*?\)/g, "")
              .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")   // links: keep text
              .replace(/<[^>]+>/g, " ")
              .replace(/^#{1,6}\s+/gm, "")                // strip heading markers
              .replace(/^\s*[-*+]\s+/gm, ". ")            // bullets → sentence breaks
              .replace(/^\s*\d+\.\s+/gm, ". ")            // numbered lists → sentence breaks
              .replace(/\*\*|__/g, "")                     // bold markers
              .replace(/[*_]/g, "")                        // italic markers
              .replace(/\n{2,}/g, ".\n")                   // paragraph breaks → sentence break
              .replace(/\s+/g, " ").trim();
  if(!t) return [];
  if(t.length <= TTS_CHUNK_TARGET) return [t];
  // Split at sentence boundaries: .!?;: followed by whitespace
  const sentences = [];
  let buf = "";
  for(let i = 0; i < t.length; i++){
    buf += t[i];
    const ch = t[i];
    if(i < t.length - 1 && (ch === '.' || ch === '!' || ch === '?' || ch === ';' || ch === ':')){
      const next = t[i+1];
      if(next === ' ' || next === '\n'){
        sentences.push(buf.trim());
        buf = "";
      }
    }
  }
  if(buf.trim()) sentences.push(buf.trim());
  // Accumulate sentences into chunks near TTS_CHUNK_TARGET
  const chunks = [];
  let cur = "";
  for(const s of sentences){
    if(s.length > TTS_CHUNK_TARGET){
      if(cur) { chunks.push(cur); cur = ""; }
      let rem = s;
      while(rem.length > TTS_CHUNK_TARGET){
        let cut = rem.lastIndexOf(' ', TTS_CHUNK_TARGET);
        if(cut < 200) cut = TTS_CHUNK_TARGET;
        chunks.push(rem.substring(0, cut).trim());
        rem = rem.substring(cut).trim();
      }
      if(rem) cur = rem;
    } else if(cur.length + s.length + 1 > TTS_CHUNK_TARGET){
      chunks.push(cur);
      cur = s;
    } else {
      cur += (cur ? " " : "") + s;
    }
  }
  if(cur) chunks.push(cur);
  return chunks;
}

async function fetchTtsBlob(text){
  if(!text) throw new Error("empty text");
  const key = ttsTextKey(text);
  if(ttsBlobCache.has(key)) return ttsBlobCache.get(key);
  if(ttsPending.has(key))   return ttsPending.get(key);
  const p = (async ()=>{
    const r = await fetch("./tts", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({text})});
    if(!r.ok) throw new Error("tts " + r.status);
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    ttsBlobCache.set(key, url);
    return url;
  })();
  ttsPending.set(key, p);
  try { return await p; } finally { ttsPending.delete(key); }
}

function preemptTts(text){
  if(!text || text.length < 20) return;
  const chunks = splitTtsChunks(text);
  // Warm cache for first 2 chunks
  for(let i = 0; i < Math.min(2, chunks.length); i++){
    fetchTtsBlob(chunks[i]).catch(err=>console.warn("[tts preempt]", err.message || err));
  }
}

let ttsSession = null;
let _ttsRaf = null; // requestAnimationFrame handle for progress bar

class TtsSession {
  constructor(text){
    this.chunks = splitTtsChunks(text);
    this.blobUrls = new Array(this.chunks.length).fill(null);
    this.durations = new Array(this.chunks.length).fill(0); // audio duration per chunk (filled after load)
    this.currentChunk = 0;
    this.audio = null;
    this.rate = 1.0;
    this.paused = false;
    this.aborted = false;
  }
  async start(){
    if(!this.chunks.length){ stopTts(); return; }
    // Fetch ALL chunks eagerly so buffer bar fills up
    for(let i = 0; i < this.chunks.length; i++) this._fetchChunk(i);
    try {
      this.blobUrls[0] = await this._fetchChunk(0);
      this._playChunk(0);
    } catch(err){
      console.error("[tts] chunk 0 failed:", err);
      stopTts();
    }
  }
  _fetchChunk(i){
    if(i >= this.chunks.length) return Promise.resolve(null);
    if(this.blobUrls[i]) return Promise.resolve(this.blobUrls[i]);
    return fetchTtsBlob(this.chunks[i]).then(url=>{
      this.blobUrls[i] = url;
      _updateTtsBar(); // update buffer bar when a chunk loads
      return url;
    }).catch(err=>{
      console.warn("[tts] chunk " + i + " fetch failed:", err.message||err);
      this.blobUrls[i] = "ERR";
      return "ERR";
    });
  }
  _playChunk(i){
    if(this.aborted) return;
    while(i < this.chunks.length && this.blobUrls[i] === "ERR") i++;
    if(i >= this.chunks.length){ stopTts(); return; }
    this.currentChunk = i;
    const url = this.blobUrls[i];
    if(!url){
      _updateTtsBar();
      this._fetchChunk(i).then(()=> this._playChunk(i));
      return;
    }
    const audio = new Audio(url);
    audio.playbackRate = this.rate;
    audio.onloadedmetadata = ()=>{ this.durations[i] = audio.duration; _updateTtsBar(); };
    audio.onended = ()=> this._onChunkEnded();
    audio.onerror = ()=>{ console.warn("[tts] audio error chunk " + i); this._onChunkEnded(); };
    this.audio = audio;
    _updateTtsBar();
    if(!this.paused){
      audio.play().catch(err=> console.warn("[tts] play() rejected:", err));
    }
  }
  _onChunkEnded(){
    if(this.aborted) return;
    const next = this.currentChunk + 1;
    if(next >= this.chunks.length){ stopTts(); return; }
    if(this.blobUrls[next] && this.blobUrls[next] !== "ERR"){
      this._playChunk(next);
    } else {
      this.audio = null;
      _updateTtsBar();
      this._fetchChunk(next).then(()=> this._playChunk(next));
    }
  }
  togglePause(){
    if(!this.audio) return;
    if(this.paused){ this.audio.play().catch(()=>{}); this.paused = false; }
    else { this.audio.pause(); this.paused = true; }
    _updateTtsBar();
  }
  setRate(rate){
    this.rate = rate;
    if(this.audio) this.audio.playbackRate = rate;
  }
  stop(){
    this.aborted = true;
    if(this.audio){ try{ this.audio.pause(); this.audio.onended=null; }catch{} }
    this.audio = null;
  }
  // Returns 0..1 for how far through the entire session we are
  getPlaybackFraction(){
    const n = this.chunks.length;
    if(n <= 1 && this.audio && this.audio.duration){
      return this.audio.currentTime / this.audio.duration;
    }
    const chunkFrac = this.audio && this.audio.duration > 0 ? this.audio.currentTime / this.audio.duration : 0;
    return (this.currentChunk + chunkFrac) / n;
  }
  // Returns 0..1 for how much is buffered (fetched)
  getBufferFraction(){
    const loaded = this.blobUrls.filter(u => u && u !== "ERR").length;
    return loaded / this.chunks.length;
  }
}

function playTts(text){
  stopTts();
  const session = new TtsSession(text);
  ttsSession = session;
  _showTtsControls();
  const cached = ttsBlobCache.get(ttsTextKey(session.chunks[0] || ""));
  if(cached) session.blobUrls[0] = cached;
  session.start().catch(err=>{
    console.error("[tts] session failed:", err);
    stopTts();
  });
}

function togglePauseTts(){
  if(ttsSession) ttsSession.togglePause();
}
function cycleTtsSpeed(){
  if(!ttsSession) return;
  const rates = [1.0, 1.25, 1.5, 2.0, 0.85];
  const i = rates.indexOf(ttsSession.rate);
  const newRate = rates[(i+1) % rates.length];
  ttsSession.setRate(newRate);
  _updateTtsBar();
}
function stopTts(){
  if(_ttsRaf){ cancelAnimationFrame(_ttsRaf); _ttsRaf = null; }
  if(ttsSession){ ttsSession.stop(); ttsSession = null; }
  document.querySelectorAll(".tts-controls").forEach(b=>b.remove());
}
function _showTtsControls(){
  document.querySelectorAll(".tts-controls").forEach(b=>b.remove());
  const bar = mk("div","tts-controls");
  const pause = mk("button","tts-btn"); pause.id="ttsPause"; pause.textContent="\u25CB"; pause.onclick=togglePauseTts; pause.title="Pause/Resume";
  // Progress bar container (YouTube-style)
  const progWrap = mk("div","tts-bar-wrap"); progWrap.id="ttsBarWrap";
  const bufBar = mk("div","tts-bar-buf"); bufBar.id="ttsBufBar";
  const playBar = mk("div","tts-bar-play"); playBar.id="ttsPlayBar";
  progWrap.appendChild(bufBar); progWrap.appendChild(playBar);
  const label = mk("span","tts-bar-label"); label.id="ttsBarLabel"; label.textContent="Loading\u2026";
  const speed = mk("button","tts-btn"); speed.id="ttsSpeed"; speed.textContent="1x"; speed.onclick=cycleTtsSpeed; speed.title="Cycle speed";
  const stop  = mk("button","tts-btn tts-stop"); stop.textContent="\u23F9"; stop.onclick=stopTts; stop.title="Stop";
  bar.appendChild(pause); bar.appendChild(progWrap); bar.appendChild(label); bar.appendChild(speed); bar.appendChild(stop);
  document.body.appendChild(bar);
  // Start animation loop for smooth progress bar
  _startTtsRaf();
}
function _startTtsRaf(){
  function tick(){
    if(!ttsSession){ _ttsRaf = null; return; }
    _renderTtsBar();
    _ttsRaf = requestAnimationFrame(tick);
  }
  _ttsRaf = requestAnimationFrame(tick);
}
function _renderTtsBar(){
  if(!ttsSession) return;
  const bufBar = document.getElementById("ttsBufBar");
  const playBar = document.getElementById("ttsPlayBar");
  const label = document.getElementById("ttsBarLabel");
  const pause = document.getElementById("ttsPause");
  const speed = document.getElementById("ttsSpeed");
  if(bufBar) bufBar.style.width = (ttsSession.getBufferFraction() * 100) + "%";
  if(playBar) playBar.style.width = (ttsSession.getPlaybackFraction() * 100) + "%";
  if(label){
    const n = ttsSession.chunks.length;
    const loaded = ttsSession.blobUrls.filter(u => u && u !== "ERR").length;
    if(!ttsSession.audio) label.textContent = "Buffering\u2026 " + loaded + "/" + n;
    else if(n <= 1) label.textContent = "";
    else label.textContent = (ttsSession.currentChunk+1) + " / " + n;
  }
  if(pause) pause.textContent = ttsSession.audio ? (ttsSession.paused ? "\u25B6" : "\u23F8") : "\u25CB";
  if(speed) speed.textContent = ttsSession.rate + "x";
}
function _updateTtsBar(){ _renderTtsBar(); }
