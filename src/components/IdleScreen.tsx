
import styles from './IdleScreen.module.css';
import { Button } from './Button';

type Props = {
  status: 'idle' | 'calling';
  onStartCall: () => void;
};

export function IdleScreen({ status, onStartCall }: Props) {
  return (
    <div className={styles['idle-page']}>
      <div>
        <h1 className={styles.title}>Welcome!</h1>
        <Button loading={status === 'calling'} onClick={onStartCall}>
          Start call
        </Button>
      </div>
    </div>
  );
}
