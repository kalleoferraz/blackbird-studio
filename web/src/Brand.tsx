/** The Blackbird logo (docs: "Logo design"), cropped to the badge. */
export function BlackbirdIcon() {
  return <img className="logo" src="/app/logo.svg" alt="Blackbird" width="28" height="28" />;
}
export function Brand({ as: Tag = 'span', children = 'Blackbird Studio' }: { as?: 'span' | 'h1'; children?: string }) {
  return <Tag className="brand"><BlackbirdIcon />{children}</Tag>;
}
