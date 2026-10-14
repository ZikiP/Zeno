import { useEffect, useState } from 'react';
import { getBookmarks, removeBookmark, updateBookmarkNote, type Bookmark } from '@/store/db';

export default function BookmarkPanel({
  pluginId,
  slug,
  onJump,
  onClose,
}: {
  pluginId: string;
  /** 只传则看该漫画的全部；不传看当前插件的全部 */
  slug?: string;
  onJump: (b: Bookmark) => void;
  onClose: () => void;
}) {
  const [items, setItems] = useState<Bookmark[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const load = () => {
    getBookmarks(pluginId, slug).then(setItems);
  };

  useEffect(load, [pluginId, slug]);

  const saveNote = async (key: string) => {
    await updateBookmarkNote(key, draft.trim());
    setEditing(null);
    load();
  };

  return (
    <div className="drawer-mask" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer__head">
          <div className="drawer__title">{slug ? '本书书签' : '全部书签'}</div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        {items === null ? (
          <div className="loading">读取中</div>
        ) : items.length === 0 ? (
          <div className="empty" style={{ padding: '40px 20px' }}>
            <div style={{ fontSize: 13 }}>还没有书签</div>
            <div style={{ fontSize: 11.5 }}>阅读时长按图片或 B 键加书签</div>
          </div>
        ) : (
          <div className="drawer__list">
            {items.map((b) => (
              <div key={b.key} className="bm-item">
                <button
                  className="bm-item__main"
                  onClick={() => {
                    onJump(b);
                    onClose();
                  }}
                >
                  {b.thumb ? (
                    <img className="bm-item__thumb" src={b.thumb} alt="" loading="lazy" />
                  ) : (
                    <div className="bm-item__thumb bm-item__thumb--ph" />
                  )}
                  <div className="bm-item__text">
                    <div className="bm-item__title">
                      {b.chapterTitle ?? b.chapterId}
                    </div>
                    <div className="bm-item__meta">
                      第 {b.page + 1} 页 · {Math.round(b.percent)}%
                    </div>
                    {b.note && <div className="bm-item__note">{b.note}</div>}
                  </div>
                </button>

                <div className="bm-item__ops">
                  <button
                    className="icon-btn"
                    title="写笔记"
                    onClick={() => {
                      setEditing(b.key);
                      setDraft(b.note ?? '');
                    }}
                  >
                    ✎
                  </button>
                  <button
                    className="icon-btn"
                    title="删除"
                    onClick={async () => {
                      if (confirm('删除这个书签？')) {
                        await removeBookmark(b.key);
                        load();
                      }
                    }}
                  >
                    ✕
                  </button>
                </div>

                {editing === b.key && (
                  <div className="bm-item__edit">
                    <textarea
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="写点什么…"
                      rows={3}
                      autoFocus
                    />
                    <div className="bm-item__edit-ops">
                      <button className="btn btn--ghost btn--sm" onClick={() => setEditing(null)}>
                        取消
                      </button>
                      <button className="btn btn--sm" onClick={() => saveNote(b.key)}>
                        保存
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
