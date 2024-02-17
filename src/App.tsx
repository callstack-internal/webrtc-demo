import { nanoid } from 'nanoid';

import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { CallScreen } from './components/CallScreen';
import { IdleScreen } from './components/IdleScreen';

type CallStatus = 'idle' | 'calling' | 'in-progress';

function App() {
  const id = useRef(nanoid()).current;

  const [status, setStatus] = useState<CallStatus>('idle');

  const [reactions, setReactions] = useState<string[]>([]);

  const sendReactionRef = useRef<((reaction: string) => void) | null>(null);
  const disposeRef = useRef<(() => void) | null>(null);

  const remoteRef = useRef<HTMLVideoElement>(null);
  const localRef = useRef<HTMLVideoElement>(null);

  /**
   * Create a new WebSocket connection to the server.
   */
  const createSocket = async () => {
    const socket = new WebSocket(
      // Use wss:// for secure connections to avoid mixed content errors
      // This is necessary when the app is deployed or tunnelled
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${
        location.host
      }/socket`
    );

    // Wait for the WebSocket connection to open
    await new Promise((resolve) => {
      socket.onopen = resolve;
    });

    return socket;
  };

  /**
   * Start a new call with the other peer.
   */
  const onStartCall = async () => {
    try {
      setStatus('calling');

      /**
       * Set up the WebSocket connection.
       * It's used to send and receive WebRTC signaling data.
       */
      const webSocket = await createSocket();

      /**
       * Set up the local media stream for sending video and audio.
       * This will also request permission from the user to access their camera and microphone.
       */
      const localStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });

      /**
       * Create a new RTCPeerConnection to manage WebRTC connections.
       * This will use Google's public STUN servers for NAT traversal.
       */
      const peerConnection = new RTCPeerConnection({
        iceServers: [
          {
            urls: [
              'stun:stun1.l.google.com:19302',
              'stun:stun2.l.google.com:19302',
            ],
          },
        ],
      });

      /**
       * Create a data channel to send text data between peers.
       */
      const dataChannel = peerConnection.createDataChannel('reactions');

      sendReactionRef.current = (reaction: string) => {
        dataChannel.send(reaction);
      };

      /**
       * Store the dispose function in the ref for cleanup later.
       */
      disposeRef.current = () => {
        // Close the connection, stop all tracks and cleanup refs
        webSocket.close();
        peerConnection.close();

        localStream.getTracks().forEach((track) => {
          track.stop();
        });

        sendReactionRef.current = null;
        disposeRef.current = null;
      };

      /**
       * Receive text data from the other peer and store it in the state.
       */
      peerConnection.ondatachannel = ({ channel }) => {
        if (channel.label === 'reactions') {
          channel.onmessage = ({ data }) => {
            setReactions((reactions) => [...reactions, data]);
          };
        }
      };

      /**
       * Add the local media stream to the peer connection.
       */
      localStream.getTracks().forEach((track) => {
        peerConnection.addTrack(track, localStream);
      });

      /**
       * Once the remote media stream is available, add it to the video element.
       */
      peerConnection.ontrack = (event) => {
        const remoteStream = event.streams[0];

        // Synchronously update the status so we have the refs available immediately
        flushSync(() => {
          setStatus('in-progress');
        });

        // Show the remote video stream for the call
        if (remoteRef.current) {
          remoteRef.current.srcObject = remoteStream;
        }

        // Show the local video stream for a preview
        if (localRef.current) {
          localRef.current.srcObject = localStream;
        }

        // Play a notification sound to indicate that the call has started
        new Audio('/alert-start.mp3').play();
      };

      /**
       * Once the ICE candidate has been gathered, send it to the other peer.
       * The ICE candidate contains information about how to connect to the peer.
       */
      peerConnection.onicecandidate = ({ candidate }) => {
        if (candidate) {
          webSocket.send(JSON.stringify({ id, candidate }));
        }
      };

      /**
       * Send an offer to the other peer on initial setup or network changes.
       */
      let makingOffer = false;
      let ignoreOffer = false;

      const makeOffer = async () => {
        try {
          makingOffer = true;

          const offer = await peerConnection.createOffer();

          await peerConnection.setLocalDescription(offer);

          webSocket.send(
            JSON.stringify({
              id,
              description: peerConnection.localDescription,
            })
          );
        } catch (error) {
          console.error(error);
        } finally {
          makingOffer = false;
        }
      };

      peerConnection.onnegotiationneeded = () => {
        makeOffer();
      };

      /**
       * Handle changes to the ICE connection state to detect network disconnections.
       */
      peerConnection.oniceconnectionstatechange = () => {
        // If the connection failed, try to restart the ICE connection.
        // This will trigger the onnegotiationneeded event and create a new offer.
        if (peerConnection.iceConnectionState === 'failed') {
          peerConnection.restartIce();
        }

        // If the connection is disconnected, update the status and clean up the resources
        if (peerConnection.iceConnectionState === 'disconnected') {
          onDisconnect();
        }
      };

      /**
       * Set up the WebSocket message handler to receive signaling data from the other peer.
       */
      webSocket.onmessage = async (event) => {
        const data = JSON.parse(event.data);

        // We got an offer or answer from the other peer
        if (data.description) {
          // To avoid race conditions when 2 peers send offers at the same time
          // We make one of the peers "polite"
          // The polite peer will rollback its local description and wait for the other peer to create an answer
          // We use ID comparison to mark one peer as polite and the other impolite consistently
          const polite = data.id.localeCompare(id) === 1;

          const offerCollision =
            data.description.type == 'offer' &&
            (makingOffer || peerConnection.signalingState !== 'stable');

          ignoreOffer = !polite && offerCollision;

          if (ignoreOffer) {
            if (!makingOffer) {
              // After ignoring polite offer, send a new offer to the other peer
              // This makes sure offer is sent even if `onnegotiationneeded` is not triggered
              makeOffer();
            }

            return;
          }

          if (offerCollision) {
            await Promise.all([
              peerConnection.setLocalDescription({ type: 'rollback' }),
              peerConnection.setRemoteDescription(data.description),
            ]);
          } else {
            await peerConnection.setRemoteDescription(data.description);
          }

          // If we got an offer, create an answer and send it to the other peer
          if (data.description.type === 'offer') {
            await peerConnection.setLocalDescription(
              await peerConnection.createAnswer()
            );

            webSocket.send(
              JSON.stringify({
                id,
                description: peerConnection.localDescription,
              })
            );
          }
        }

        // We got an ICE candidate from the other peer, add it to the peer connection
        if (data.candidate) {
          try {
            await peerConnection.addIceCandidate(
              new RTCIceCandidate(data.candidate)
            );
          } catch (error) {
            if (!ignoreOffer) {
              console.error(error);
            }
          }
        }
      };
    } catch (error) {
      console.error(error);

      onDisconnect();
    }
  };

  /**
   * End the current call and clean up the resources.
   */
  const onDisconnect = () => {
    try {
      // Play a sound to indicate that the call has ended
      new Audio('/alert-stop.mp3').play();

      setStatus('idle');
      setReactions([]);

      disposeRef.current?.();
    } catch (error) {
      console.error(error);
    }
  };

  /**
   * Send a reaction to the other peer.
   */
  const onReaction = (reaction: string) => {
    sendReactionRef.current?.(reaction);
  };

  if (status === 'in-progress') {
    return (
      <CallScreen
        reactions={reactions}
        onReaction={onReaction}
        onDisconnect={onDisconnect}
        remoteRef={remoteRef}
        localRef={localRef}
      />
    );
  }

  return <IdleScreen status={status} onStartCall={onStartCall} />;
}

export default App;
