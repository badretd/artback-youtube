import { Icon } from './Icons.jsx';

export default function Brand({ size = 'md', href = null }) {
  const content = (
    <>
      <span className={`brand-mark brand-mark-${size}`}>
        <Icon name="play" size={size === 'lg' ? 22 : 16} />
      </span>
      <span className={`brand-text brand-text-${size}`}>ARTBACK</span>
    </>
  );

  if (href) {
    return (
      <a className={`brand brand-${size}`} href={href}>
        {content}
      </a>
    );
  }
  return <div className={`brand brand-${size}`}>{content}</div>;
}
