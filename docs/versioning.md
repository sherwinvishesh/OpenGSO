# Versioning

OmniGEO carries two version numbers, and they move independently.

## The package version

The five published packages (`omnigeo`, `omnigeo-cli`, `omnigeo-testing`, `omnigeo-generate`,
`omnigeo-prod`) follow semver. They are one `fixed` group in Changesets, so they always share a
version, and a release of any of them releases all five. Today all five are `0.1.0`.

Nothing is on npm yet. Until 1.0, any minor release may change a command, a flag, a config field
or an export.

## The spec version: `omnigeo/1.0`

`omnigeo/1.0` names the wire format in [spec.md](spec.md): the twin URL convention, content
negotiation, the response headers, the 406, and the frontmatter. It is the `AEO_SPEC_VERSION`
constant, and it appears in:

- the `X-AEO-Version` header on each markdown response and 406 prod sends, and on the HTML pages
  it adds headers to;
- `specVersion` in `.omnigeo/manifest.json`;
- the generated-by marker in the `robots.txt`, `llms.txt` and `sitemap.xml` that generate writes.

It names what goes over the wire, not which release produced it. A package release changes it only
when the wire format itself changes, so many package versions can implement `omnigeo/1.0`, and a
package going to 1.0 does not by itself change the spec version. Check B12 in `omnigeo test` passes
on any `X-AEO-Version` value; it checks that a site says which spec it implements, not which one.

`createProdHandler` and `createNextMiddleware` take a `specVersion` option that overrides the
header value. See [prod-api.md](prod-api.md).

## The manifest version

`.omnigeo/manifest.json` has its own `version` field, currently `1`, for the file's internal
shape. It is not part of the wire format. When generate finds a manifest with a different version,
it reports the file as unreadable and starts from an empty one.
