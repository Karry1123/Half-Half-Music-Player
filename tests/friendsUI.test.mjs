import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
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
