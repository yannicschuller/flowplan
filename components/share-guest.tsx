// Guests of an edit link working on a whiteboard or notebook (#280,
// lib/share-canvas.ts): which link, and this browser tab's id for pointers.
export type ShareGuest = { token: string; clientId: string };
export const shareBoardUrl = (guest: ShareGuest) => `/api/share/${encodeURIComponent(guest.token)}/board`;
export const shareNotebookUrl = (guest: ShareGuest) => `/api/share/${encodeURIComponent(guest.token)}/notebook`;
export const shareFileUrl = (guest: ShareGuest, file: string) => `/api/share/${encodeURIComponent(guest.token)}/files/${encodeURIComponent(file)}`;
