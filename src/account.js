import { AccountClient } from '../public/accountClient.js';
const stored = key => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
export const account = new AccountClient((stored('hh.api') || window.HH_CONFIG?.apiBase || '/music-api').replace(/\/+$/, ''));
export const accessToken = () => account.required ? account.token : stored('hh.apiToken');
