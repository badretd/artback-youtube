let io = null;
const onlineUsers = new Map();

export function setIO(instance) {
  io = instance;
}

export function getIO() {
  return io;
}

export function emitToMembers(event, data) {
  io?.to('members').emit(event, data);
}

export function emitToUser(userId, event, data) {
  io?.to(`user:${userId}`).emit(event, data);
}

export function disconnectUser(userId) {
  io?.in(`user:${userId}`).disconnectSockets(true);
}

export function addOnline(userId, socketId) {
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socketId);
}

export function removeOnline(userId, socketId) {
  const set = onlineUsers.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) onlineUsers.delete(userId);
}

export function onlineIds() {
  return [...onlineUsers.keys()];
}

export function isOnline(userId) {
  return onlineUsers.has(userId);
}

export function broadcastPresence() {
  if (!io) return;
  const ids = onlineIds();
  io.to('members').emit('presence', { count: ids.length, ids });
}
