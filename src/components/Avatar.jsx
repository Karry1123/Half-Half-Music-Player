export function Avatar({ profile, size = 40, title }) {
  if (!profile) {
    return (
      <span className="avatar empty" style={{ width: size, height: size, fontSize: size * 0.4 }} title={title || '等待加入'}>
        ?
      </span>
    );
  }
  const initial = [...(profile.name || '?')][0].toUpperCase();
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.42, background: profile.color }} title={title || profile.name}>
      {initial}
    </span>
  );
}
