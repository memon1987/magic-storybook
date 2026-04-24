import { Skia } from '@shopify/react-native-skia';

type Value = string | number;

export const glsl = (
  source: TemplateStringsArray,
  ...values: Value[]
): string => source.flatMap((s, i) => [s, values[i]]).filter(Boolean).join('');

export const frag = (source: TemplateStringsArray, ...values: Value[]) => {
  const code = glsl(source, ...values);
  const rt = Skia.RuntimeEffect.Make(code);
  if (rt === null) {
    throw new Error("Couldn't compile page curl shader");
  }
  return rt;
};

export const Core = glsl`
const float PI = ${Math.PI};
const vec4 TRANSPARENT = vec4(0., 0., 0., 0.);

mat3 translate(vec2 p) {
  return mat3(1.0,0.0,0.0,0.0,1.0,0.0,p.x,p.y,1.0);
}

mat3 scale(vec2 s, vec2 p) {
  return translate(p) * mat3(s.x,0.0,0.0,0.0,s.y,0.0,0.0,0.0,1.0) * translate(-p);
}

vec2 project(vec2 p, mat3 m) {
  return (inverse(m) * vec3(p, 1.)).xy;
}

struct Context {
  half4 color;
  float2 p;
  float2 resolution;
};
`;
