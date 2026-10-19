/** Resolve Markdown resources against the viewed file, not the dashboard URL.
 * Only project-local URLs receive credentials; external links never do.
 */
export function projectResourceUrl(
  href: string | undefined,
  sourcePath: string,
  accessToken: string,
): string | undefined {
  if (!href || href.startsWith("#") || href.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(href)) {
    return href;
  }
  const base = new URL(`/${sourcePath.replace(/^\/+/, "")}`, "http://project.invalid");
  const resource = new URL(href, base);
  resource.searchParams.set("token", accessToken);
  return `${resource.pathname}${resource.search}${resource.hash}`;
}
