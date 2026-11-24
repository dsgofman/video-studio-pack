import { Composition } from 'remotion';
import { Video } from './Video.jsx';
import { Thumbnail } from './Thumbnail.jsx';
import { ShortCover } from './ShortCover.jsx';

// durationInFrames is computed from the beats passed in inputProps (calculateMetadata).
export const RemotionRoot = () => {
  return (
    <>
      <Composition
        id="video"
        component={Video}
        durationInFrames={300}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{ fps: 30, width: 1920, height: 1080, beats: [] }}
        calculateMetadata={({ props }) => {
          const fps = props.fps || 30;
          const total = (props.beats || []).reduce((a, b) => a + (b.durationInFrames || 0), 0)
            + (props.endCard ? Math.round((props.endCard.seconds || 12) * fps) : 0);
          return {
            durationInFrames: Math.max(1, total),
            fps,
            width: props.width || 1920,
            height: props.height || 1080,
          };
        }}
      />
      {/* Single-frame thumbnail TEXT-OVERLAY still (rendered via render/thumb.mjs + renderStill). */}
      <Composition
        id="Thumbnail"
        component={Thumbnail}
        durationInFrames={1}
        fps={30}
        width={1920}
        height={1080}
        defaultProps={{ art: '', hook: 'HEADLINE', accent: '#FF7A1A', side: 'right', font: 'anton' }}
      />
      {/* Single-frame 1080x1920 vertical Short COVER still (rendered via render/cover.mjs + renderStill). */}
      <Composition
        id="ShortCover"
        component={ShortCover}
        durationInFrames={1}
        fps={30}
        width={1080}
        height={1920}
        defaultProps={{ art: '', hook: 'HEADLINE', accent: '#FF7A1A' }}
      />
    </>
  );
};
