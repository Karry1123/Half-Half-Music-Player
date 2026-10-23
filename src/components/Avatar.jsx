// Preserve saved colors and choose the higher-contrast foreground.
function avatarForeground(color) {
  const hex = String(color || '').replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return 'var(--color-avatar-dark)';
  const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  return (luminance + 0.05) / 0.0539 >= 1.05 / (luminance + 0.05)
    ? 'var(--color-avatar-dark)' : 'var(--color-avatar-light)';
}

export function Avatar({ profile, size = 40, title }) {
  if (!profile) {
    return (
      <span className="avatar empty" style={{ width: size, height: size, fontSize: size <= 24 ? 'var(--text-caption-size)' : 'var(--text-body-size)' }} role="img" aria-label={title || '等待加入'} title={title || '等待加入'}>
        ?
      </span>
    );
  }
  const initial = [...(profile.name || '?')][0].toUpperCase();
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size <= 24 ? 'var(--text-caption-size)' : size >= 44 ? 'var(--text-title-sm-size)' : 'var(--text-body-size)', background: profile.color, '--avatar-fg': avatarForeground(profile.color) }} role="img" aria-label={title || profile.name} title={title || profile.name}>
      {initial}
    </span>
  );
}
