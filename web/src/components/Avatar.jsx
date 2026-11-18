import { useEffect, useState } from 'react';
import { initials } from '../format.js';

export default function Avatar({ user, size = 48, className = '' }) {
  const [failed, setFailed] = useState(false);
  const name = user?.channelTitle || user?.displayName || '?';
  const url = user?.avatarUrl;

  useEffect(() => {
    setFailed(false);
  }, [url]);

  if (url && !failed) {
    return (
      <img
        className={`avatar ${className}`}
        src={url}
        alt={name}
        width={size}
        height={size}
        style={{ width: size, height: size }}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span
      className={`avatar avatar-fallback ${className}`}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
      aria-label={name}
    >
      {initials(name)}
    </span>
  );
}
