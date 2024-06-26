/**
 * Multitrack is a super-plugin for creating a multitrack audio player.
 * Individual tracks are synced and played together.
 * They can be dragged to set their start position.
 * The top track is meant for dragging'n'dropping an additional track id (not a file).
 */
import WaveSurfer, { type WaveSurferOptions } from 'wavesurfer.js'
import WebAudioPlayer from './webaudio'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js'
import TimelinePlugin, { type TimelinePluginOptions } from 'wavesurfer.js/dist/plugins/timeline.js'
import EnvelopePlugin, { type EnvelopePoint, type EnvelopePluginOptions } from 'wavesurfer.js/dist/plugins/envelope.js'
import EventEmitter from 'wavesurfer.js/dist/event-emitter.js'
import { makeDraggable } from 'wavesurfer.js/dist/draggable.js'
import getPlaceholderURL from './placeholderURL.jsx'
import toWav from 'audiobuffer-to-wav';
import RenderAudio from './renderAudio';
import './multitrack.css';
import loadingGIF from './Loading.gif';
import NavStore from '../../NavigationStore';

export type TrackId = string | number

type SingleTrackOptions = Omit<
  WaveSurferOptions,
  'container' | 'minPxPerSec' | 'duration' | 'cursorColor' | 'cursorWidth' | 'interact' | 'hideScrollbar'
>



export type TrackOptions = {
  id: TrackId
  url?: string
  peaks?: WaveSurferOptions['peaks']
  envelope?: boolean | EnvelopePoint[]
  draggable?: boolean
  startPosition: number
  startCue?: number
  endCue?: number
  fadeInEnd?: number
  fadeOutStart?: number
  volume?: number
  markers?: Array<{
    time: number
    label?: string
    color?: string
    end: number
  }>
  intro?: {
    endTime: number
    label?: string
    color?: string
  }
  options?: SingleTrackOptions
}

export type MultitrackOptions = {
  container: HTMLElement
  minPxPerSec?: number
  cursorColor?: string
  cursorWidth?: number
  trackBackground?: string
  trackBorderColor?: string
  rightButtonDrag?: boolean
  dragBounds?: boolean
  envelopeOptions?: EnvelopePluginOptions
  timelineOptions?: TimelinePluginOptions
}

export type MultitrackEvents = {
  canplay: []
  'start-position-change': [{ id: TrackId; startPosition: number }]
  'start-cue-change': [{ id: TrackId; startCue: number }]
  'end-cue-change': [{ id: TrackId; endCue: number }]
  'fade-in-change': [{ id: TrackId; fadeInEnd: number }]
  'fade-out-change': [{ id: TrackId; fadeOutStart: number }]
  'envelope-points-change': [{ id: TrackId; points: EnvelopePoint[] }]
  'volume-change': [{ id: TrackId; volume: number }]
  'intro-end-change': [{ id: TrackId; endTime: number }]
  'marker-change': [{ id: TrackId; startMarker: number, endMarker: number }]
  drop: [{ id: TrackId }]
}

export type MultitrackTracks = Array<TrackOptions>





const PLACEHOLDER_TRACK = {
  id: 'placeholder',
  url: getPlaceholderURL(),
  //url: 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU2LjM2LjEwMAAAAAAAAAAAAAAA//OEAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAEAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV6urq6urq6urq6urq6urq6urq6urq6urq6v////////////////////////////////8AAAAATGF2YzU2LjQxAAAAAAAAAAAAAAAAJAAAAAAAAAAAASDs90hvAAAAAAAAAAAAAAAAAAAA//MUZAAAAAGkAAAAAAAAA0gAAAAATEFN//MUZAMAAAGkAAAAAAAAA0gAAAAARTMu//MUZAYAAAGkAAAAAAAAA0gAAAAAOTku//MUZAkAAAGkAAAAAAAAA0gAAAAANVVV',
  peaks: [[0]],
  startPosition: 0,
  options: { height: 0 },
}


class MultiTrack extends EventEmitter<MultitrackEvents> {
  private tracks: MultitrackTracks
  private options: MultitrackOptions
  private audios: Array<HTMLAudioElement | WebAudioPlayer> = []
  private wavesurfers: Array<WaveSurfer> = []
  private envelopes: Array<EnvelopePlugin> = []
  private durations: Array<number> = []
  private currentTime = 0
  private maxDuration = 0
  private rendering: ReturnType<typeof initRendering>
  private frameRequest: number | null = null
  private subscriptions: Array<() => void> = []
  private audioContext: AudioContext
  private wavesurferReadyStatus: Array<boolean> = []


  static create(tracks: MultitrackTracks, options: MultitrackOptions): MultiTrack {
    return new MultiTrack(tracks, options)
  }
  constructor(tracks: MultitrackTracks, options: MultitrackOptions) {
    super()
    this.audioContext = new AudioContext()
    this.tracks = tracks.concat({ ...PLACEHOLDER_TRACK }).map((track) => ({
      ...track,
      startPosition: track.startPosition || 0,
      peaks: track.peaks || (track.url || track.options?.media ? undefined : [new Float32Array(1024)]),
    }))
    this.options = options
    this.rendering = initRendering(this.tracks, this.options)
    this.rendering.addDropHandler((trackId: TrackId) => {
      this.emit('drop', { id: trackId })
    })

    this.initAllAudios().then((durations) => {
      this.initDurations(durations)
      this.initAllWavesurfers()
      this.rendering.containers.forEach((container, index) => {
        if (tracks[index]?.draggable) {
          const unsubscribe = initDragging(
            container,
            (delta: number) => this.onDrag(index, delta),
            options.rightButtonDrag,
          )
          this.wavesurfers[index].once('destroy', unsubscribe)
        }
      })
      this.rendering.addClickHandler((position) => {
        this.seekTo(position)
      })
      this.emit('canplay')
    })
  }
  private initDurations(durations: number[]) {
    this.durations = durations
    this.maxDuration = this.tracks.reduce((max, track, index) => {
      return Math.max(max, track.startPosition + durations[index])
    }, 0)
    const placeholderAudioIndex = this.audios.findIndex((a) => a.src === PLACEHOLDER_TRACK.url)
    const placeholderAudio = this.audios[placeholderAudioIndex]
    if (placeholderAudio) {
      ;(placeholderAudio as WebAudioPlayer & { duration: number }).duration = this.maxDuration
      this.durations[placeholderAudioIndex] = this.maxDuration
    }
    this.rendering.setMainWidth(durations, this.maxDuration)
  }
  private initAudio(track: TrackOptions): Promise<HTMLAudioElement | WebAudioPlayer> {
    const isIOS = /iPhone|iPad/.test(navigator.userAgent)
    const isPlaceholderTrack = track.id === PLACEHOLDER_TRACK.id
    const audio =
      track.options?.media || (isIOS || isPlaceholderTrack ? new WebAudioPlayer(this.audioContext) : new Audio())
    audio.crossOrigin = 'anonymous'
    if (track.url) {
      audio.src = track.url
    }
    if (track.volume !== undefined) audio.volume = track.volume
    return new Promise<typeof audio>((resolve) => {
      if (!audio.src) return resolve(audio)
      ;(audio as HTMLAudioElement).addEventListener('loadedmetadata', () => resolve(audio), { once: true })
    })
  }
  private async initAllAudios(): Promise<number[]> {
    this.audios = await Promise.all(this.tracks.map((track) => this.initAudio(track)))
    return this.audios.map((a) => (a.src ? a.duration : 0))
  }
  private initWavesurfer(track: TrackOptions, index: number): WaveSurfer {
    const container = this.rendering.containers[index]

    
    
    // Create a wavesurfer instance
    const ws = WaveSurfer.create({
      ...track.options,
      container,
      minPxPerSec: 0,
      media: this.audios[index] as HTMLMediaElement,
      peaks:
        track.peaks ||
        (this.audios[index] instanceof WebAudioPlayer
          ? (this.audios[index] as WebAudioPlayer).getChannelData()
          : undefined),
      duration: this.durations[index],
      cursorColor: 'transparent',
      cursorWidth: 0,
      interact: false,
      hideScrollbar: true,
    })
    ws.on('loading', () => {
      this.wavesurferReadyStatus[index] = false;
      this.showLoadingScreen(index.toString());
      //console.log("ws load")
    });
    ws.on('ready', () => {
      //console.log("ws ready")
      this.hideLoadingScreen(index.toString());
      this.wavesurferReadyStatus[index] = true;
    });

    if (track.id === PLACEHOLDER_TRACK.id) {
      ws.registerPlugin(
        TimelinePlugin.create({
          container: this.rendering.containers[0].parentElement,
          ...this.options.timelineOptions,
        } as TimelinePluginOptions),
      )
    }

    // Regions and markers
    const wsRegions = RegionsPlugin.create()
    ws.registerPlugin(wsRegions)

    this.subscriptions.push(
      ws.once('decode', () => {
        // Start and end cues
        if (track.startCue != null || track.endCue != null) {
          const { startCue = 0, endCue = this.durations[index] } = track
          const startCueRegion = wsRegions.addRegion({
            start: 0,
            end: startCue,
            color: 'rgba(0, 0, 0, 0.7)',

          })
          const endCueRegion = wsRegions.addRegion({
            start: endCue,
            end: this.durations[index],
            color: 'rgba(0, 0, 0, 0.7)',
          })

          // Allow resizing only from one side
          startCueRegion.element.firstElementChild?.remove()
          endCueRegion.element.lastChild?.remove()

          // Update the start and end cues on resize
          this.subscriptions.push(
            startCueRegion.on('update-end', () => {
              track.startCue = startCueRegion.end
              this.emit('start-cue-change', { id: track.id, startCue: track.startCue as number })
            }),

            endCueRegion.on('update-end', () => {
              track.endCue = endCueRegion.start
              this.emit('end-cue-change', { id: track.id, endCue: track.endCue as number })
            }),
          )
        }

        // Intro
        if (track.intro) {
          const introRegion = wsRegions.addRegion({
            start: 0,
            end: track.intro.endTime,
            content: track.intro.label,
            color: this.options.trackBackground,
            drag: false,
          })
          introRegion.element.querySelector('[part*="region-handle-left"]')?.remove()
          ;(introRegion.element.parentElement as HTMLElement).style.mixBlendMode = 'plus-lighter'
          introRegion.element.style.color = '#cccccc'
          introRegion.element.style.padding = '0 5px'
          if (track.intro.color) {
            const rightHandle = introRegion.element.querySelector('[part*="region-handle-right"]') as HTMLElement
            if (rightHandle) {
              rightHandle.style.borderColor = track.intro.color
            }
          }

          this.subscriptions.push(
            introRegion.on('update-end', () => {
              this.emit('intro-end-change', { id: track.id, endTime: introRegion.end })
            }),
          )
        }

        // Render markers
        if (track.markers) {
          track.markers.forEach((marker) => {
            const MarkerRegion = wsRegions.addRegion({
              start: marker.time,
              end: marker.end,
              content: marker.label,
              minLength: 0,
              color: marker.color,
              //resize: false,
            })
            //track.markers[0].start = marker.time;
            MarkerRegion.element.style.color = '#cccccc'

            this.subscriptions.push(
              MarkerRegion.on('update-end', () => {
                if (track.markers && track.markers.length > 0) {
                  //console.log("markery: ", track.markers)
                  track.markers[0].time = MarkerRegion.start
                  track.markers[0].end = MarkerRegion.end
                
                this.emit('marker-change', {
                  id: track.id, startMarker: track.markers[0].time as number,
                  endMarker: track.markers[0].end as number
                })
              }
              }),
            )

          })

        }
      }),
    )

    
    if (track.envelope) {
      // Envelope
      
      const envelope = ws.registerPlugin(
        EnvelopePlugin.create({
          ...this.options.envelopeOptions,
          volume: track.volume,
          lineColor: 'hsla(163, 95%, 33%, 0.9)',
          dragPointSize: 15,
          lineWidth: '4',
        }),
      )
      
      if (Array.isArray(track.envelope)) {
        envelope.setPoints(track.envelope)
      }

      if (track.fadeInEnd) {
        if (track.startCue) {
          envelope.addPoint({ time: track.startCue || 0, volume: 0, id: 'startCue' })
        }
        envelope.addPoint({ time: track.fadeInEnd || 0, volume: track.volume ?? 1, id: 'fadeInEnd' })
      }

      if (track.fadeOutStart) {
        envelope.addPoint({ time: track.fadeOutStart, volume: track.volume ?? 1, id: 'fadeOutStart' })
        if (track.endCue) {
          envelope.addPoint({ time: track.endCue, volume: 0, id: 'endCue' })
        }
      }

      this.envelopes[index] = envelope

      const setPointTimeById = (id: string, time: number) => {
        const points = envelope.getPoints()
        const newPoints = points.map((point) => {
          if (point.id === id) {
            return { ...point, time }
          }
          return point
        })
        envelope.setPoints(newPoints)
      }

      let prevFadeInEnd = track.fadeInEnd
      let prevFadeOutStart = track.fadeOutStart

      this.subscriptions.push(
        envelope.on('volume-change', (volume) => {
          this.emit('volume-change', { id: track.id, volume })
        }),
        
        envelope.on('points-change', (points) => {
          
          const fadeIn = points.find((point) => point.id === 'fadeInEnd')
          if (fadeIn && fadeIn.time !== prevFadeInEnd) {
            this.emit('fade-in-change', { id: track.id, fadeInEnd: fadeIn.time })
            prevFadeInEnd = fadeIn.time
          }

          const fadeOut = points.find((point) => point.id === 'fadeOutStart')
          if (fadeOut && fadeOut.time !== prevFadeOutStart) {
            this.emit('fade-out-change', { id: track.id, fadeOutStart: fadeOut.time })
            prevFadeOutStart = fadeOut.time
          }

          this.emit('envelope-points-change', { id: track.id, points })
          
        }),

        this.on('start-cue-change', ({ id, startCue }) => {
          if (id === track.id) {
            setPointTimeById('startCue', startCue)
          }
        }),

        this.on('end-cue-change', ({ id, endCue }) => {
          if (id === track.id) {
            setPointTimeById('endCue', endCue)
          }
        }),

        ws.on('decode', () => {
          envelope.setVolume(track.volume ?? 1)
        }),
      )
    }
    return ws
  
  }
  private initAllWavesurfers() {
    
    const wavesurfers = this.tracks.map((track, index) => {
      return this.initWavesurfer(track, index)
    })
    this.wavesurfers = wavesurfers
    
  }
  private updatePosition(time: number, autoCenter = false) {
    const precisionSeconds = 0.3
    const isPaused = !this.isPlaying()
    if (time !== this.currentTime) {
      this.currentTime = time
      this.rendering.updateCursor(time / this.maxDuration, autoCenter)
    }
    // Update the current time of each audio
    this.tracks.forEach((track, index) => {
      const audio = this.audios[index]
      const duration = this.durations[index]
      const newTime = time - track.startPosition
      if (audio && Math.abs(audio.currentTime - newTime) > precisionSeconds) {
        audio.currentTime = Math.max(0, newTime)
      }
      // If the position is out of the track bounds, pause it
      if (isPaused || newTime < 0 || newTime > duration) {
        audio && !audio.paused && audio.pause()
      } else if (!isPaused) {
        // If the position is in the track bounds, play it
        audio && audio.paused && audio.play()
      }
      // Unmute if cue is reached
      const isMuted = newTime < (track.startCue || 0) || newTime > (track.endCue || Infinity)
      if (audio && isMuted !== audio.muted) audio.muted = isMuted
    })
  }
  private onDrag(index: number, delta: number) {
    const track = this.tracks[index]
    if (!track.draggable) return

    const newStartPosition = track.startPosition + delta * this.maxDuration
    const minStart = this.options.dragBounds ? 0 : -this.durations[index] - 1
    const maxStart = this.maxDuration - this.durations[index]
    if (newStartPosition >= minStart && newStartPosition <= maxStart) {
      track.startPosition = newStartPosition
      this.initDurations(this.durations)
      this.rendering.setContainerOffsets()
      this.updatePosition(this.currentTime)
      this.emit('start-position-change', { id: track.id, startPosition: newStartPosition })
    }
  }
  private findCurrentTracks(): number[] {
    // Find the audios at the current time
    const indexes: number[] = []
    this.tracks.forEach((track, index) => {
      if (
        (track.url || track.options?.media) &&
        this.currentTime >= track.startPosition &&
        this.currentTime < track.startPosition + this.durations[index]
      ) {
        indexes.push(index)
      }
    })
    if (indexes.length === 0) {
      const minStartTime = Math.min(...this.tracks.filter((t) => t.url).map((track) => track.startPosition))
      indexes.push(this.tracks.findIndex((track) => track.startPosition === minStartTime))
    }
    return indexes
  }
  private startSync() {
    const onFrame = () => {
      const position = this.audios.reduce<number>((pos, audio, index) => {
        if (!audio.paused) {
          pos = Math.max(pos, audio.currentTime + this.tracks[index].startPosition)
        }
        return pos
      }, this.currentTime)
      if (position > this.currentTime) {
        this.updatePosition(position, true)
      }
      this.frameRequest = requestAnimationFrame(onFrame)
      }
    onFrame()
    }
  private startSyncIfAllReady() {
      if (this.wavesurferReadyStatus.every(status => status === true)) {
        this.startSync();
      }
    }
  public play() {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume()
    }
    
    this.startSyncIfAllReady()
    const indexes = this.findCurrentTracks()
    indexes.forEach((index) => {
      if(this.wavesurferReadyStatus[index] === true){
      if (this.audios[index]) {
        const playPromise = this.audios[index].play();
        if (playPromise !== undefined) {
          playPromise.then(_ => {
            // Automatic playback started!
            // Show playing UI.
          })
            .catch(error => {
              // Auto-play was prevented
              // Show paused UI.
              console.error("Error playing audio: ", error, " audio id: ", index);
            });
        }
      }
    }
    else{
      this.stop();
    }
    })
  }
  
  public pause() {
    this.audios.forEach((audio) => {
      if (!audio.paused) {
        audio.pause()
      }
    })
  }
  
  public stop() {
    this.audios.forEach((audio) => {
      if (!audio.paused) {
        audio.pause();
      }
      audio.currentTime = 0; // Ustawienie czasu audio na początek
    });
    this.updatePosition(0,false)
  }
  isWaveSurferReady(id: number): boolean {
    return this.wavesurferReadyStatus[id] || false;
  }
  private processAudioPlayer = (player: WebAudioPlayer, src: string, id: number, 
    startSec: number, endSec: number, speedRatio: number,  option: string) => {
      
    fetch(src)
      .then(response => response.arrayBuffer())
      .then(arrayBuffer => this.audioContext.decodeAudioData(arrayBuffer))
      .then(audioBuffer => {
        player.Buffer = audioBuffer;
        player.src = src;
        
        if (player instanceof WebAudioPlayer)
          {
            if(startSec < 0){ 
              startSec = 0;
            }
            if(endSec > player.Buffer.duration){
              endSec = player.Buffer.duration;
            }
            if(option === 'cut')
              {
                const temp_start = this.tracks[id].startPosition;
                player.cutSegment(startSec, endSec);
                this.tracks[id].startPosition = startSec + temp_start;
              }
            else if(option === 'delete')
              {
                player.removeSegment(startSec, endSec);
              }
            else if(option === 'mute')
              {
                player.muteSegment(startSec, endSec);
              }
            else if(option === 'reverse')
              {
                player.reverseSegment(startSec, endSec);
              }
            else if(option === 'speed')
                {
                  //console.log("actualSpeed ratio", speedRatio)
                  player.speedSegment(startSec, endSec, speedRatio);

                }
          
          const wav = toWav(player.Buffer); // Konwertuj AudioBuffer na arrayBuffer formatu WAV
          const blob = new Blob([wav], {type: 'audio/wav'}); // Stwórz Blob z danych WAV
          const urlNewAudio = URL.createObjectURL(blob);
          this.audios[id] = new Audio(urlNewAudio);
          this.addTrack({
            id: this.tracks[id].id,
            url:  this.audios[id].src,
            startPosition: this.tracks[id].startPosition,
            volume: this.tracks[id].volume,
            draggable: true,
            envelope: [
              { time: 0.001, volume: 1 },
              { time: player.Buffer.duration - 0.001, volume: 1 },
            ],
            options: {
              waveColor: this.tracks[id].options?.waveColor,
              progressColor: this.tracks[id].options?.progressColor,
            },
            intro: {
              label: this.tracks[id]?.intro?.label || '',
              endTime: 0,
            }
          })
        }
        else {
          // audioPlayer jest HTMLAudioElement, obsłuż inaczej
          console.log("Operacja nieobsługiwana dla HTMLAudioElement.");
        }
        
        
      });
  }
  public EditSegment(id: number, startSec: number, endSec: number, speedRatio: number, option: string) {
    let audioPlayer = this.audios[id];

    
    if (audioPlayer instanceof WebAudioPlayer) {

      this.processAudioPlayer(audioPlayer, audioPlayer.src, id, startSec, endSec, speedRatio, option);
    } else {

      // Utwórz MediaElementAudioSourceNode z HTMLAudioElement
      this.audioContext.createMediaElementSource(audioPlayer);
      audioPlayer.src = this.audios[id].src;
      //console.log("Źródło audio: ", audioPlayer.src);
      // Utwórz nową instancję WebAudioPlayer z AudioContext
      const webAudioPlayer = new WebAudioPlayer(this.audioContext);
      this.processAudioPlayer(webAudioPlayer, audioPlayer.src, id, startSec, endSec, speedRatio, option);
      
    }

  }

  showLoadingScreen(trackId: string) {
    let loadingScreen = document.getElementById(`loading-screen-${trackId}`);
    if (loadingScreen) {
    loadingScreen.style.display = 'block';
    }
  }

  hideLoadingScreen(trackId: string) {
    const loadingScreen = document.getElementById(`loading-screen-${trackId}`);
    if (loadingScreen) {
      loadingScreen.style.display = 'none';
    }
  }

  public isPlaying() {
    return this.audios.some((audio) => !audio.paused)
  }

  public getCurrentTime() {
    return this.currentTime
  }

  /** Position percentage from 0 to 1 */
  public seekTo(position: number) {
    const wasPlaying = this.isPlaying()
    this.updatePosition(position * this.maxDuration)
    if (wasPlaying) this.play()
  }
  /** Set time in seconds */
  public setTime(time: number) {
    const wasPlaying = this.isPlaying()
    this.updatePosition(time)
    if (wasPlaying) this.play()
  }

  public zoom(pxPerSec: number) {
    this.options.minPxPerSec = pxPerSec
    this.wavesurfers.forEach((ws, index) => this.tracks[index].url && this.isWaveSurferReady(index) && ws.zoom(pxPerSec))
    this.rendering.setMainWidth(this.durations, this.maxDuration)
    this.rendering.setContainerOffsets()
  }
  public addTrack(track: TrackOptions) {
    //console.log("id:", this.tracks.findIndex((t) => t.id === track.id ) )

    const index = this.tracks.findIndex((t) => t.id === track.id)
    if (index !== -1) {
      this.tracks[index] = track
      console.log('Adding track', this.tracks[index])
      this.initAudio(track).then((audio) => {
        this.audios[index] = audio
        this.durations[index] = audio.duration
        this.initDurations(this.durations)
        const container = this.rendering.containers[index]
        if (container.firstChild instanceof Element && container.firstChild.classList.contains('dropArea')) {
          container.removeChild(container.firstChild);
        }

        this.wavesurfers[index].destroy()
        
        this.wavesurfers[index] = this.initWavesurfer(track, index)
        
        const unsubscribe = initDragging(
          container,
          (delta: number) => this.onDrag(index, delta),
          this.options.rightButtonDrag,
        )
        this.wavesurfers[index].once('destroy', unsubscribe)
        this.stop()
        this.setTime(0);
        
        this.emit('canplay')
      })
    }
    
  }
  public removeTrack(trackId: string) {
    
    const track_ID = parseInt(trackId);
    
    if (track_ID !== -1 && this.tracks[track_ID]?.url) {
      
      console.log('Removing track', track_ID)
      const trackAdd = {
        id: this.tracks[track_ID].id,
        startPosition: 0,
        //options: { height: 0 },
      }
      const index = this.tracks.findIndex((t) => t.id === trackAdd.id)
    if (index !== -1) {
        this.tracks[index] = trackAdd
        this.initAudio(PLACEHOLDER_TRACK).then((audio) => {
        this.audios[index] = audio
        this.durations[index] = audio.duration
        this.initDurations(this.durations)

        const container = this.rendering.containers[index]
        if (container.firstChild instanceof Element && container.firstChild.classList.contains('dropArea')) {
          container.removeChild(container.firstChild);
        }
        this.wavesurfers[index].destroy()
        this.wavesurfers[index] = this.initWavesurfer(trackAdd, index)
        const unsubscribe = initDragging(
          container,
          (delta: number) => this.onDrag(index, delta),
          this.options.rightButtonDrag,
        )
        this.wavesurfers[index].once('destroy', unsubscribe)
      })
        }
        this.stop()
        this.setTime(0);
        this.currentTime = 0;
        this.emit('canplay')


    }
  }
  public async renderMultiTrackAudio(option: string, RenderName: string, bitrate: number) {
    
    
    const indexes = Array.from(this.tracks.keys());
    const maxDuration = this.tracks.reduce((max, track, index) => {
      if (track.id !== PLACEHOLDER_TRACK.id) {
        return Math.max(max, track.startPosition + this.durations[index]);
      } else {return max;}
    }, 0);
    const sampleRate = 44100; // Standardowa częstotliwość próbkowania
    if(maxDuration === 0) return;
    const OffContext = new OfflineAudioContext(2, sampleRate * maxDuration, sampleRate)
    let i = 1;
    for (let index of indexes) {
      if(this.tracks[index].id === PLACEHOLDER_TRACK.id){continue;}
      else if (this.tracks[index].url){

        if(option === 'wav')
          {
            if(i<10)
              {
                NavStore.getState().setProgressBar(10*i);
                i++;
              }
          }

        console.log("index: ", index)
      
        const track = this.tracks[index];
        const audio = this.audios[index];
        const duration = this.durations[index];
        const startPosition = track.startPosition;
        const gainNode = OffContext.createGain();
        
        //console.log("startPosition: ", startPosition, " duration: ", duration, " audio: ", audio)
        if (audio instanceof WebAudioPlayer) {
            const source = OffContext.createBufferSource();

            source.buffer = audio.Buffer;
            source.connect(gainNode);
            gainNode.connect(OffContext.destination);
            const points = this.envelopes[index]?.getPoints();
            if (points) {
              // Ustaw początkową głośność na wartość pierwszego punktu
              gainNode.gain.setValueAtTime(points[0].volume, points[0].time);
  
              // Następnie dla każdego kolejnego punktu, stwórz liniowe przejście do jego głośności
              for (let i = 1; i < points.length; i++) {
                gainNode.gain.linearRampToValueAtTime(points[i].volume, points[i].time);
              }
            }
            // Rozpocznij odtwarzanie w odpowiednim miejscu i czasie
            source.start(startPosition, 0, duration);
            console.log(source)
            
        }
        else {
          const response = await fetch(audio.src);
          const arrayBuffer = await response.arrayBuffer();
          const audioBuffer = await OffContext.decodeAudioData(arrayBuffer);
          // Utwórz BufferSource z danymi audio
          const source = OffContext.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(gainNode);
          gainNode.connect(OffContext.destination);
          const points = this.envelopes[index]?.getPoints();
          if (points) {
            // Ustaw początkową głośność na wartość pierwszego punktu
            gainNode.gain.setValueAtTime(points[0].volume, points[0].time);

            // Następnie dla każdego kolejnego punktu, stwórz liniowe przejście do jego głośności
            for (let i = 1; i < points.length; i++) {
              gainNode.gain.linearRampToValueAtTime(points[i].volume, points[i].time);
            }
          }
          // Rozpocznij odtwarzanie w odpowiednim miejscu i czasie
          source.start(startPosition, 0, duration);
        }
      } 
    }
    const renderedBuffer = await OffContext.startRendering();
    const renderAudio = new RenderAudio();
    if(option === 'wav')
      {
        renderAudio.renderAsWav(renderedBuffer, RenderName);
      }
    else if(option === 'mp3')
      {
        renderAudio.renderAsMp3(renderedBuffer, RenderName, bitrate);
      }
    
  }
  
  
  public destroy() {
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest)

    this.rendering.destroy()

    this.audios.forEach((audio) => {
      audio.pause()
      audio.src = ''
    })

    this.wavesurfers.forEach((ws) => {
      ws.destroy()
    })
  }

  

  // See https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/setSinkId
  public setSinkId(sinkId: string): Promise<void[]> {
    return Promise.all(this.wavesurfers.map((ws) => ws.setSinkId(sinkId)))
  }

  public setTrackVolume(index: number, volume: number) {
    ;(this.envelopes[index] || this.wavesurfers[index])?.setVolume(volume)
  }


  public getEnvelopePoints(trackIndex: number): EnvelopePoint[] | undefined {
    return this.envelopes[trackIndex]?.getPoints()
  }

  public setEnvelopePoints(trackIndex: number, points: EnvelopePoint[]) {
    this.envelopes[trackIndex]?.setPoints(points)
  }
}

function initRendering(tracks: MultitrackTracks, options: MultitrackOptions) {
  let pxPerSec = 0
  let durations: number[] = []
  let mainWidth = 0
  //getEncodedPlaceholderURL().then(data => console.log(data));
  // Create a common container for all tracks
  const scroll = document.createElement('div')
  scroll.setAttribute('style', 'width: 88vw; overflow-x: auto; overflow-y: auto; user-select: none;')
  const wrapper = document.createElement('div')
  scroll.classList.add('scroll-track');
  wrapper.className = 'tracks-container';
  wrapper.style.position = 'relative'
  scroll.style.maxHeight = '89vh';
  scroll.appendChild(wrapper)
  options.container.appendChild(scroll)
  // Create a common cursor
  const cursor = document.createElement('div')
  cursor.setAttribute('style', 'height: 100%; position: absolute; z-index: 10; top: 0; left: 0; pointer-events: none;')
  cursor.style.backgroundColor = options.cursorColor || '#000'
  cursor.style.width = `${options.cursorWidth ?? 1}px`
  wrapper.appendChild(cursor)
  const { clientWidth } = wrapper

  // Create containers for each track
  const containers = tracks.map((track, index) => {

    
    const container = document.createElement('div')

    container.className = 'track';
    container.style.position = 'relative'

    // Atrybut data-id na id tracka
    container.setAttribute('track-id', track.id.toString());
    // Add button only if there's audio associated with the track
    if (track.id === PLACEHOLDER_TRACK.id) {
      container.style.display = 'none'
    }

    if (options.trackBorderColor && index > 0) {
      const borderDiv = document.createElement('div')
      borderDiv.className = 'border-div';
      borderDiv.setAttribute('style', `width: 100%; height: 2px; background-color: ${options.trackBorderColor}`)
      wrapper.appendChild(borderDiv)
    }

    if (options.trackBackground && (track.url || track.options?.media)) {
      container.style.background = options.trackBackground
    }

    // No audio on this track, so make it droppable
    if (!(track.url || track.options?.media)) {
      const dropArea = document.createElement('div')
      dropArea.setAttribute(
        'style',
        `position: absolute; z-index: 10; left: 10px; top: 10px; right: 10px; bottom: 10px; border: 2px dashed ${options.trackBorderColor};`,
      )
      dropArea.className = 'dropArea';
      dropArea.addEventListener('dragover', (e) => {
        e.preventDefault()
        dropArea.style.background = options.trackBackground || ''
      })
      dropArea.addEventListener('dragleave', (e) => {
        e.preventDefault()
        dropArea.style.background = ''
      })
      dropArea.addEventListener('drop', (e) => {
        e.preventDefault()
        dropArea.style.background = ''
      })


      container.appendChild(dropArea)
    }
    const loading = document.createElement('div')
    loading.setAttribute(
      'style',
      `display: none; position: absolute; z-index: 10; left: 10px; top: 10px; right: 10px; bottom: 10px; background: rgba(0,0,0,0.5);`,
    )
    loading.innerHTML = `<img src=${loadingGIF} style="height: 10vh; " alt="Loading...">`;
    loading.id = `loading-screen-${track.id.toString()}`;
    container.appendChild(loading)
    wrapper.appendChild(container)

    return container
  })

  // Set the positions of each container
  const setContainerOffsets = () => {
    containers.forEach((container, i) => {
      const offset = tracks[i].startPosition * pxPerSec
      if (durations[i]) {
        container.style.width = `${durations[i] * pxPerSec}px`
      }
      container.style.transform = `translateX(${offset}px)`
    })
  }

  return {
    containers,

    // Set the start offset
    setContainerOffsets,

    // Set the container width
    setMainWidth: (trackDurations: number[], maxDuration: number) => {
      durations = trackDurations
      pxPerSec = Math.max(options.minPxPerSec || 0, clientWidth / maxDuration)
      mainWidth = pxPerSec * maxDuration
      wrapper.style.width = `${mainWidth}px`
      setContainerOffsets()
    },

    // Update cursor position
    updateCursor: (position: number, autoCenter: boolean) => {
      cursor.style.left = `${Math.min(100, position * 100)}%`

      // Update scroll
      const { clientWidth, scrollLeft } = scroll
      const center = clientWidth / 2
      const minScroll = autoCenter ? center : clientWidth
      const pos = position * mainWidth

      if (pos > scrollLeft + minScroll || pos < scrollLeft) {
        scroll.scrollLeft = pos - center
      }
    },

    // Click to seek
    addClickHandler: (onClick: (position: number) => void) => {
      wrapper.addEventListener('click', (e) => {
        const rect = wrapper.getBoundingClientRect()
        const x = e.clientX - rect.left
        const position = x / wrapper.offsetWidth
        onClick(position)
      })
    },

    // Destroy the container
    destroy: () => {
      scroll.remove()
    },

    // Do something on drop
    addDropHandler: (onDrop: (trackId: TrackId) => void) => {
      tracks.forEach((track, index) => {
        
        if (!(track.url || track.options?.media)) {
          const droppable = containers[index].querySelector('div')
          if (droppable) {
            droppable.addEventListener('drop', (e) => {
              e.preventDefault();
              onDrop(track.id);
            });
          } else {
            console.log('Droppable element not found for index', index);
          }
        }
      })

      
    },



    
  }
  
}



function initDragging(container: HTMLElement, onDrag: (delta: number) => void, rightButtonDrag = false) {
  let overallWidth = 0

  const unsubscribe = makeDraggable(
    container,
    (dx: number) => {
      onDrag(dx / overallWidth)
    },
    () => {
      container.style.cursor = 'grabbing'
      overallWidth = container.parentElement?.offsetWidth ?? 0
    },
    () => {
      container.style.cursor = 'grab'
    },
    5,
    rightButtonDrag ? 2 : 0,
  )

  const preventDefault = (e: Event) => e.preventDefault()

  container.style.cursor = 'grab'

  if (rightButtonDrag) {
    container.addEventListener('contextmenu', preventDefault)
  }

  return () => {
    container.style.cursor = ''
    unsubscribe()
    if (rightButtonDrag) {
      container.removeEventListener('contextmenu', preventDefault)
    }
  }
}

export default MultiTrack
