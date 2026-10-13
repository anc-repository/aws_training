/**
 * 全局读屏播报区 LiveRegion（08 §5.5、§8.4）：一个 polite、一个 assertive 区域，内容来自 lib/announce。
 * 同一主题 3 秒内合并由 announce() 处理；每条播报先清空再写入，保证重复文字也会被读出。
 */
import { useEffect, useState } from 'react';
import { subscribeAnnouncements } from '../lib/announce';

export function LiveRegion() {
  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  useEffect(
    () =>
      subscribeAnnouncements((a) => {
        const set = a.politeness === 'assertive' ? setAssertive : setPolite;
        set('');
        setTimeout(() => set(a.text), 30);
      }),
    [],
  );
  return (
    <>
      <div className="sr" aria-live="polite" data-live="polite">
        {polite}
      </div>
      <div className="sr" role="alert" data-live="assertive">
        {assertive}
      </div>
    </>
  );
}
