import styles from './Button.module.css';

type Props = {
  variant?: 'primary' | 'danger';
  loading?: boolean;
  children: string;
  onClick: () => void;
}

export function Button({ variant = 'primary', loading, children, onClick }: Props) {
  return (
    <button disabled={loading} className={`${styles.button} ${styles[variant]} ${loading ? styles.loading : ''}`} onClick={onClick}>
      {children}
    </button>
  )
}
