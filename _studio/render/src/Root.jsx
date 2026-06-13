import { Composition } from 'remotion';
import { Video } from './Video.jsx';

// durationInFrames is computed from the beats passed in inputProps (calculateMetadata).
export const RemotionRoot = () => {
  return (
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
  );
};
