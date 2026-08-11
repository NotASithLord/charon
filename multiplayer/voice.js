// Charon's standalone page uses the same audited native-media primitive as the
// peerd App parent. The dwapp path still keeps SDP, ICE, and MediaStreams on the
// trusted side of the bridge.
export { createRoomVoice, isRoomVoiceSignal } from './peerd-browser.js';
