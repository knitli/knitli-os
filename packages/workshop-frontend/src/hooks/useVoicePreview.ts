import { useCallback, useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'

/**
 * Plays fixed-text voice previews (AuthenticatedApi.previewVoice) for the voice pickers. One
 * preview at a time: starting another, replaying the current one, or unmounting stops playback.
 */
export const useVoicePreview = (api: RpcStub<AuthenticatedApi> | null) => {
  const [playing, setPlaying] = useState<{ modelId: string; voiceId: string } | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  const generationRef = useRef(0)

  const stop = useCallback(() => {
    generationRef.current += 1
    audioRef.current?.pause()
    audioRef.current = null
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    setPlaying(null)
  }, [])

  useEffect(() => stop, [stop])

  const play = useCallback(async (modelId: string, voiceId: string) => {
    if (!api) return
    if (playing?.modelId === modelId && playing?.voiceId === voiceId) {
      stop()
      return
    }
    const turn = generationRef.current + 1
    generationRef.current = turn
    audioRef.current?.pause()
    audioRef.current = null
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    setPlaying(null)
    const bytes = await api.previewVoice(modelId, voiceId)
    if (generationRef.current !== turn) return
    // Copy into a fresh ArrayBuffer-backed view: the RPC-decoded bytes may carry a
    // SharedArrayBuffer-backed type Blob won't accept.
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/mpeg' }))
    urlRef.current = url
    const audio = new Audio(url)
    audioRef.current = audio
    setPlaying({ modelId, voiceId })
    const release = () => {
      if (audioRef.current === audio) stop()
    }
    audio.addEventListener('ended', release)
    audio.addEventListener('error', release)
    try {
      await audio.play()
    } catch (err) {
      if (audioRef.current === audio) stop()
      throw err
    }
  }, [api, playing, stop])

  const isPlaying = useCallback((modelId: string, voiceId: string) =>
    playing?.modelId === modelId && playing?.voiceId === voiceId, [playing])

  return { isPlaying, play }
}
