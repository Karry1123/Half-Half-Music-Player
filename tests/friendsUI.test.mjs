import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FriendIdentity, coListeningLabel } from '../public/friendsUI.js';

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
