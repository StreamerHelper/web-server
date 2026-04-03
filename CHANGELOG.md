# Changelog
## [2.0.0] - 2026-03-10
### Refactor
- v2 version

## [1.0.1] - 2022-01-24
### Added
- 支持`log`可定义级别的推送，目前支持邮箱&&微信(Server酱)

### Changed
- 优化日志，删除`package-lock.json`

## [1.0.0] - 2022-01-16
### Added
- 新增扫码登录，目前仅支持这种登陆方式
- 支持标题占位符`{{name}} {{time}}`

### Changed
- `streamerInfo`中的主播项不再以主播名成为`key`，而是单独写到`name`字段

### Removed
- 弃用账号密码登录
