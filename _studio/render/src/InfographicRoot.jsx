import { Composition } from 'remotion';
import { InfographicStill } from './Infographic.jsx';

export const InfographicRoot = () => (
  <Composition
    id="infographic"
    component={InfographicStill}
    durationInFrames={1}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={{ type: 'timeline', bars: [], markers: [] }}
  />
);
