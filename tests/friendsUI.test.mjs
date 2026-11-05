import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import htm from 'htm';
import { renderToStaticMarkup } from 'react-dom/server';
import { FriendIdentity, coListeningLabel } from '../public/friendsUI.js';
import { AccountClient } from '../public/accountClient.js';

test('friends cache renders during a stalled refresh, shares requests and isolates accounts', async () => {
  const client = new AccountClient('https://test');
  client.user = { id: 'alice', isActivated: true };
  client.token = 'alice-token';
  const cached = [{ id: 'bob', nickname: 'Cached Bob' }];
  client.read = async () => JSON.stringify(cached);
  client.store = async () => {};
  let release, requests = 0, observed;
  client.request = () => { requests++; return new Promise(resolve => { release = resolve; }); };
  const unsubscribe = client.subscribeFriends(value => { observed = value; });
  const first = client.loadFriends(), second = client.loadFriends();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.deepEqual(client.getCachedFriends(), cached);
  assert.deepEqual(observed, cached);
  release([{ id: 'bob', nickname: 'New Bob' }]);
  await Promise.all([first, second]);
  assert.equal(client.getCachedFriends()[0].nickname, 'New Bob');
  await client.loadFriends();
  assert.equal(requests, 1, 'fresh memory cache avoids a second panel refetch');
  const forced = client.loadFriends({ force: true });
  assert.equal(requests, 2);
  client.user = { id: 'charlie', isActivated: true };
  client.token = 'charlie-token';
  assert.deepEqual(client.getCachedFriends(), []);
  release([{ id: 'private-alice-friend' }]); await forced;
  assert.deepEqual(client.getCachedFriends(), []);
  assert.equal(observed[0].nickname, 'New Bob', 'late response is not published to a new account');
  unsubscribe();
});

test('friend identity shows that friend’s latest nickname and username, never the device nickname', () => {
  const previousStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => '橘子汽水' };
  try {
    const friend = { id: 'friend-uuid', username: 'sidchy03', nickname: '他的最新昵称' };
    const markup = renderToStaticMarkup(React.createElement(FriendIdentity, { friend }));
    assert.match(markup, /他的最新昵称/);
    assert.match(markup, /\(@sidchy03\)/);
    assert.doesNotMatch(markup, /橘子汽水/);
    const fallback = renderToStaticMarkup(React.createElement(FriendIdentity, { friend: { ...friend, nickname: '' } }));
    assert.match(fallback, /sidchy03/);
    assert.doesNotMatch(fallback, /橘子汽水/);
  } finally {
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  }
});

test('co-listening label uses whole real playback minutes', () => {
  assert.equal(coListeningLabel('sidchy03', 3719), '与 @sidchy03 已共同收听 1小时1分');
  assert.equal(coListeningLabel('sidchy03', -10), '与 @sidchy03 已共同收听 0小时0分');
});

test('accepted friend menus toggle, dismiss, and preserve actions and pending buttons', async () => {
  const friends = [
    { id: 'bob', username: 'bob', status: 'accepted' },
    { id: 'eve', username: 'eve', status: 'accepted' },
    { id: 'incoming', status: 'pending', requester: 'incoming' },
    { id: 'outgoing', status: 'pending', requester: 'alice' },
  ];
  const requests = [], invites = [], listeners = new Map(), hooks = [];
  let cursor = 0, pendingEffects = [], focused = 0, refreshes = 0;
  const source = readFileSync(new URL('../public/friendsUI.js', import.meta.url), 'utf8');
  const Panel = vm.runInNewContext(`${source.slice(source.indexOf('export function FriendsPanel')).replace('export ', '')}; FriendsPanel`, {
    html: htm.bind((type, props, ...children) => ({ type, props: { ...props, children: children.length === 1 ? children[0] : children } })), FriendIdentity, coListeningLabel,
    button: 'rounded-xl border border-ink-600', useFriends: () => friends,
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [hooks[index], value => { hooks[index] = typeof value === 'function' ? value(hooks[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return hooks[index] ||= { current: initial }; },
    useEffect(effect, deps) {
      const index = cursor++, previous = hooks[index];
      if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) {
        pendingEffects.push(() => { previous?.cleanup?.(); hooks[index] = { deps, cleanup: effect() }; });
      }
    },
    document: {
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: (type, fn) => { if (listeners.get(type) === fn) listeners.delete(type); },
    },
    clearTimeout,
  });
  const props = {
    client: {
      required: true, user: { id: 'alice' },
      request: async (...args) => { requests.push(args); return { playlists: [] }; },
      loadFriends: async () => { refreshes++; },
    },
    presence: { bob: { online: true } }, invite: id => invites.push(id),
  };
  const flatten = node => Array.isArray(node) ? node.flatMap(flatten)
    : node && typeof node === 'object' ? [node, ...flatten(node.props?.children)] : [];
  let nodes;
  const render = () => {
    cursor = 0;
    nodes = flatten(Panel(props));
    for (const node of nodes) if (node.props.ref) node.props.ref.current = {
      contains: target => target === 'inside', querySelector: () => ({ focus: () => { focused++; } }),
    };
    pendingEffects.forEach(effect => effect()); pendingEffects = [];
  };
  const trigger = name => nodes.find(node => node.props['aria-label'] === `${name} 的更多操作`);
  const action = text => nodes.find(node => node.type === 'button' && node.props.children === text);
  const menus = () => nodes.filter(node => node.props.role === 'menu');
  render();
  assert.equal(menus().length, 0);
  assert.equal(action('TA的公开歌单'), undefined);
  for (const text of ['接受', '拒绝', '取消请求']) assert.ok(action(text));
  assert.equal(nodes.filter(node => node.props['aria-haspopup'] === 'menu').length, 2);
  const row = nodes.find(node => flatten(node.props.children).some(child => child === trigger('bob')) && node.type === 'div' && node.props.className.includes('justify-between'));
  assert.ok(flatten(row).some(node => node.type === 'p' && node.props.children === coListeningLabel('bob')));

  trigger('bob').props.onClick(); render();
  assert.equal(menus().length, 1);
  assert.equal(trigger('bob').props['aria-expanded'], true);
  assert.equal(action('邀请一起听').props.disabled, false);
  listeners.get('pointerdown')({ target: 'inside' }); render();
  assert.equal(menus().length, 1);
  trigger('eve').props.onClick(); render();
  assert.equal(menus().length, 1);
  assert.equal(trigger('bob').props['aria-expanded'], false);
  assert.equal(action('邀请一起听').props.disabled, true);
  trigger('eve').props.onClick(); render();
  assert.equal(menus().length, 0);

  trigger('bob').props.onClick(); render();
  listeners.get('keydown')({ key: 'Escape' }); render();
  assert.equal(menus().length, 0);
  assert.equal(focused, 1);
  assert.equal(listeners.size, 0);
  trigger('bob').props.onClick(); render();
  listeners.get('pointerdown')({ target: 'outside' }); render();
  assert.equal(menus().length, 0);

  trigger('bob').props.onClick(); render();
  action('邀请一起听').props.onClick(); render();
  assert.deepEqual(invites, ['bob']);
  assert.equal(menus().length, 0);
  trigger('bob').props.onClick(); render();
  action('TA的公开歌单').props.onClick();
  await new Promise(resolve => setImmediate(resolve)); render();
  assert.equal(requests.at(-1)[0], '/account/friends/bob/playlists');
  assert.equal(menus().length, 0);
  trigger('bob').props.onClick(); render();
  action('移除好友').props.onClick();
  await new Promise(resolve => setImmediate(resolve)); render();
  assert.deepEqual(requests.at(-1), ['/account/friends/bob', null, 'DELETE']);
  assert.equal(refreshes, 1);
  assert.equal(menus().length, 0);
  for (const hook of hooks) hook?.cleanup?.();
  assert.equal(listeners.size, 0);
});
