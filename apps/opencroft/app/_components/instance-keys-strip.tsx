import { NoticeStrip } from 'ui/layouts/notice-strip'

/**
 * The key file's warning as a line across the top of a page: on /setup, and on
 * the settings an administrator opens. The host shows it only while a key comes
 * from the key file. `notice` is the server's full text, the same words its
 * start-up log prints, and sits behind Details.
 */
export function InstanceKeysStrip({ notice }: { notice: string }) {
  return (
    <NoticeStrip tone='warning' details={notice}>
      Instance keys are stored in the data volume
    </NoticeStrip>
  )
}
