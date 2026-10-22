import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { rootCertificates } from 'node:tls';
import { once } from 'node:events';
import { fail, Semaphore } from './core.mjs';
import { recordPlaybackOutput, conversionObserver } from './playback-diagnostics.mjs';
import { TemporaryCache, mediaCacheKey } from './temporary-cache.mjs';
const require = createRequire(import.meta.url);
// Uploaded playlists must not make FFmpeg open local files or arbitrary URLs.
const inputOptions = ['-protocol_whitelist','http,https,tcp,tls,crypto','-format_whitelist','matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,avi,mp3,aac,flac,ogg,wav,asf,mpeg,mpegts,flv'];

export function mediaTracks(data) {
  return (data.streams || []).filter(s => ['video','audio','subtitle'].includes(s.codec_type)).map(s => ({ index: s.index, kind: s.codec_type, codec: s.codec_name || 'unknown', language: s.tags?.language || 'und', title: s.tags?.title?.slice(0,256) || '', default: !!s.disposition?.default, bitmap: ['dvd_subtitle','dvb_subtitle','hdmv_pgs_subtitle','xsub'].includes(s.codec_name),
    ...Object.fromEntries(['width','height','channels','sample_rate','bit_rate','duration','bits_per_raw_sample'].filter(key=>Number.isFinite(Number(s[key])) && s[key] !== undefined).map(key=>[key,Number(s[key])])),
    ...Object.fromEntries(['profile','pix_fmt','avg_frame_rate','channel_layout','color_space','color_transfer','color_primaries','field_order'].filter(key=>typeof s[key]==='string').map(key=>[key,s[key].slice(0,128)])) }));
}
export function mediaFormat(data) {
  const f=data.format||{};
  return { name: typeof f.format_name==='string'?f.format_name.slice(0,128):undefined,
    ...Object.fromEntries(['duration','bit_rate'].filter(key=>Number.isFinite(Number(f[key])) && f[key]!==undefined).map(key=>[key,Number(f[key])])) };
}
export function progressParser(update) {
  let pending='';const state={};
  return chunk=>{
    pending=(pending+chunk.toString()).slice(-8192);const lines=pending.split(/\r?\n/);pending=lines.pop();
    for(const line of lines){const match=/^(fps|speed|out_time_us|total_size|drop_frames|dup_frames|progress)=(.*)$/.exec(line);if(!match)continue;
      const [,key,value]=match;
      if(key==='progress'){update({...state,finished:value==='end'});continue;}
      const n=Number(key==='speed'?value.replace(/x$/,''):value);if(Number.isFinite(n)&&n>=0)state[key]=n;
    }
  };
}
export class Media {
  constructor(config, playback, overrides = {}) {
    this.config = config; this.playback = playback; this.spawn = overrides.spawn || spawn;
    this.ffmpeg = config.ffmpegPath || require('ffmpeg-static'); this.ffprobe = config.ffprobePath || require('@derhuerst/ffprobe-static');
    this.caFile = config.mediaCaFile || path.join(config.dataDir,'media-root-ca.pem');
    if(!config.mediaCaFile) { mkdirSync(config.dataDir,{recursive:true,mode:0o700}); writeFileSync(this.caFile,rootCertificates.join('\n'),{mode:0o600}); }
    this.transfers = new Semaphore(config.mediaConcurrency ?? 1); this.cache = overrides.cache || new TemporaryCache(config); this.probes = new Map();
  }
  available() { return this.config.mediaEnabled === true && !!this.ffmpeg && existsSync(this.ffmpeg); }
  source(ticket, purpose = 'conversion-input') { const origin = this.config.mediaNode ? `http://${this.config.host === '::1' ? '[::1]' : '127.0.0.1'}:${this.config.port}` : this.config.publicUrl; const url = new URL('/api/v1/playback', origin); url.search = new URLSearchParams({ ticket, mode: 'original', purpose }).toString(); return url.href; }
  inputOptions() { return [...inputOptions,...(this.config.mediaNode ? ['-headers', `X-Teldrive-Media-Node: ${this.config.mediaNodeSecret}\r\n`] : this.config.publicUrl.startsWith('https:') ? ['-tls_verify','1','-ca_file',this.caFile] : [])]; }
  async tracks(ticket) {
    const { file } = this.playback.resolve(ticket), key = mediaCacheKey(file, this.config);
    if (!this.config.mediaEnabled || !this.ffprobe || !existsSync(this.ffprobe)) return { available: false, tracks: [] };
    if (this.probes.has(key)) return this.probes.get(key);
    this.transfers.max = this.config.mediaConcurrency ?? 1;
    // Deduplicate the cache lookup too, without holding a conversion slot for SQL.
    const pending = (async () => {
      const cached = await this.cache.load(key);
      if (cached) return { available: true, tracks: cached.tracks, format: cached.format };
      return this.transfers.run(async () => {
      const stdout = await this.collect(this.ffprobe, ['-v','error',...this.inputOptions(),'-rw_timeout','30000000','-probesize',String(this.config.mediaProbeBytes ?? 8388608),'-analyzeduration',String((this.config.mediaAnalyzeSeconds ?? 1)*1000000),'-show_streams','-show_format','-of','json',this.source(ticket,'probe')], this.config.mediaProbeTimeoutSeconds ?? 60);
      let tracks, copyVideo, format; try { const data = JSON.parse(stdout); tracks = mediaTracks(data); format=mediaFormat(data); copyVideo = (data.streams || []).filter(s => s.codec_name === 'h264' && ['yuv420p','yuvj420p'].includes(s.pix_fmt)).map(s => s.index); } catch { fail(503,'media_probe_failed'); }
      this.cache.set(key, { tracks, copyVideo, format }); return { available: true, tracks, format };
      });
    })();
    this.probes.set(key, pending);
    try { return await pending; } finally { this.probes.delete(key); }
  }
  async collect(binary, args, seconds) {
    const child = this.spawn(binary, args, { windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let size = 0, diagnostic = ''; const chunks = []; child.stderr.on('data', b => { if(diagnostic.length < 4096) diagnostic += b.toString(); });
    const timer = setTimeout(()=>child.kill('SIGKILL'), seconds * 1000).unref();
    try {
      const completion = once(child,'close'); completion.catch(()=>{});
      for await (const bytes of child.stdout) { size += bytes.length; if (size > 2*1024*1024) { child.kill('SIGKILL'); fail(503,'media_metadata_too_large'); } chunks.push(bytes); }
      const [code,signal] = await completion; if (code !== 0) {
        console.error(JSON.stringify({ event:'media_probe_failed', code, signal, reasons:['403','404','429','TLS','certificate','timed out','Cannot allocate memory','Resource temporarily unavailable','Permission denied','Invalid data','End of file'].filter(label=>diagnostic.includes(label)) }));
        fail(503,'media_probe_failed','No se pudieron consultar las pistas del archivo.');
      }
      return Buffer.concat(chunks).toString();
    } catch (error) { if (error.status) throw error; fail(503,'media_process_failed'); }
    finally { clearTimeout(timer); child.kill('SIGKILL'); }
  }
  track(params, name, kind, tracks) {
    if (!params.has(name)) return undefined;
    const index = Number(params.get(name)); if (!Number.isInteger(index) || index < 0 || index > 1024 || !tracks.some(t=>t.index===index && t.kind===kind)) fail(422,'invalid_media_track');
    return index;
  }
  async stream(c) {
    if (!this.available()) fail(503,'media_conversion_unavailable','La conversión no está habilitada en este servidor.');
    const secret = c.query.get('ticket'), mode = c.query.get('mode'), start = Number(c.query.get('start') || 0);
    if (!Number.isFinite(start) || start < 0 || start > 86400) fail(422,'invalid_media_start');
    const { tracks } = await this.tracks(secret);
    const audio = this.track(c.query,'audio','audio',tracks), video = this.track(c.query,'video','video',tracks), subtitle = this.track(c.query,'subtitle','subtitle',tracks);
    if (subtitle !== undefined) fail(422,'bitmap_subtitle_conversion_unavailable','Esta pista necesita incrustación de subtítulos; elige una pista de texto o descarga el original.');
    const { file } = this.playback.consume(secret);
    const selectedVideo = video ?? tracks.find(t => t.kind === 'video')?.index;
    const copyVideo = this.config.mediaCopyVideo !== 0 && this.cache.get(mediaCacheKey(file, this.config))?.copyVideo.includes(selectedVideo);
    conversionObserver()({ video: mode === 'audio' ? 'none' : copyVideo ? 'copy' : 'h264', audio: mode === 'audio' ? 'mp3' : 'aac', maxWidth: this.config.mediaMaxWidth ?? 1920, threads: this.config.mediaThreads ?? 1 });
    this.transfers.max = this.config.mediaConcurrency ?? 1;
    return this.transfers.run(async () => {
      const args = ['-hide_banner','-loglevel','error','-nostdin','-threads',String(this.config.mediaThreads ?? 1),...this.inputOptions(),'-rw_timeout','30000000','-probesize',String(this.config.mediaProbeBytes ?? 8388608),'-analyzeduration',String((this.config.mediaAnalyzeSeconds ?? 1)*1000000),...(start ? ['-ss',String(start)] : []),'-i',this.source(secret)];
      if (mode === 'audio') args.push('-map',audio===undefined?'0:a:0?':`0:${audio}`,'-vn','-c:a','libmp3lame','-b:a','192k','-f','mp3');
      else args.push('-map',video===undefined?'0:v:0?':`0:${video}`,'-map',audio===undefined?'0:a:0?':`0:${audio}`,'-sn',...(copyVideo ? ['-c:v','copy'] : ['-c:v','libx264','-preset','ultrafast','-crf','23','-pix_fmt','yuv420p','-vf',`scale=w=trunc(min(iw\\,${this.config.mediaMaxWidth ?? 1920})/2)*2:h=-2`]),'-c:a','aac','-ac','2','-b:a','192k','-avoid_negative_ts','make_zero','-movflags','frag_keyframe+empty_moov+default_base_moof','-frag_duration','1000000','-f','mp4');
      await this.pipe(c, [...args,'-threads',String(this.config.mediaThreads ?? 1),'pipe:1'], mode === 'audio' ? 'audio/mpeg' : 'video/mp4');
    });
  }
  async subtitles(c) {
    const secret = c.query.get('ticket'), { tracks } = await this.tracks(secret), track = this.track(c.query,'track','subtitle',tracks), start = Number(c.query.get('start') || 0);
    if (track === undefined || tracks.find(t=>t.index===track)?.bitmap || !Number.isFinite(start) || start < 0 || start > 86400) fail(422,'invalid_subtitle_track');
    if (!this.available()) fail(503,'media_conversion_unavailable');
    this.playback.consume(secret);
    return this.transfers.run(()=>this.pipe(c,['-hide_banner','-loglevel','error','-nostdin',...this.inputOptions(),'-rw_timeout','30000000',...(start ? ['-ss',String(start)] : []),'-i',this.source(secret,'subtitle-input'),'-map',`0:${track}`,'-vn','-an','-c:s','webvtt','-f','webvtt','pipe:1'],'text/vtt; charset=utf-8',60));
  }
  async pipe(c, args, mime, timeout = this.config.mediaTimeoutSeconds ?? 7200) {
    const child = this.spawn(this.ffmpeg,['-progress','pipe:2','-nostats',...args],{ windowsHide:true,stdio:['ignore','pipe','pipe'] });
    const progress=progressParser(conversionObserver());
    let diagnostic = ''; child.stderr.on('data', b => { progress(b); if (diagnostic.length < 4096) diagnostic += b.toString(); });
    const controller = new AbortController();
    const stop = ()=>{ controller.abort(); child.kill('SIGKILL'); }, timer=setTimeout(stop,timeout*1000).unref(); c.res.once('close',stop);
    let bytes = 0;
    try {
      const completion = once(child,'close'); completion.catch(()=>{});
      c.res.setHeader('Content-Type',mime); c.res.setHeader('Accept-Ranges','none');
      for await (const chunk of child.stdout) { if(c.res.destroyed) break; bytes+=chunk.length; const ready=c.res.write(chunk);recordPlaybackOutput(chunk.length);if(!ready) await once(c.res,'drain',{signal:controller.signal}); }
      const [code]=await completion; if(c.res.destroyed) return;
      if(code!==0 || !bytes) {
        console.error(JSON.stringify({event:'media_conversion_failed',code,bytes,reasons:['403','404','429','TLS','certificate','timed out','Cannot allocate memory','Resource temporarily unavailable','Permission denied','Invalid data','End of file'].filter(label=>diagnostic.includes(label))}));
        fail(503,'media_conversion_failed','No se pudo convertir la pista seleccionada.');
      } c.res.end();
    } catch(error) { if(c.res.destroyed) return; if(error.status) throw error; fail(503,'media_process_failed'); }
    finally { clearTimeout(timer); c.res.off('close',stop); stop(); }
  }
}
