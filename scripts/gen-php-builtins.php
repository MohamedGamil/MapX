<?php
// Generates src/core/manifests/php-builtins.ts, the static list of PHP's built-in classes, functions
// and constants that external-reference attribution classifies as builtins (M5-21).
//
//   php8.1 scripts/gen-php-builtins.php dump > 8.1.json                    (once per PHP binary)
//   php scripts/gen-php-builtins.php stubs php-8.4.14 <dir>/php-8.4.14 > s84.json   (once per php-src tag)
//   php scripts/gen-php-builtins.php merge 8.1.json … s84.json > src/core/manifests/php-builtins.ts
//   php scripts/gen-php-builtins.php pecl > src/core/manifests/php-pecl.ts      (M5-21-R1)
//
// `dump` reads the running PHP by reflection: every internal class, interface, trait and enum,
// function and constant, by the extension that defines it. A build loads only some extensions, so
// `stubs` adds php-src's own declarations of every bundled extension: the `ext/<name>/*.stub.php`
// files of a release tag (https://github.com/php/php-src/tree/<tag>/ext), read with PHP's tokenizer,
// never executed. Only extensions bundled with php-src are kept (BUNDLED); PECL extensions (redis,
// imagick, xdebug, …) are not builtins of PHP. `merge` writes the union by extension, with its
// sources; a name that moved between extensions is the newest version's.
//
// `pecl` reads the running PHP's loaded extensions that php-src does not bundle (redis, imagick,
// memcached, apcu, igbinary, msgpack, xdebug, …) by reflection and writes their list: attribution
// classifies those names as `ambient` (M5-21-R1), the runtime's, neither PHP's nor a package's.

const BUNDLED = [
    'bcmath', 'bz2', 'calendar', 'com_dotnet', 'core', 'ctype', 'curl', 'date', 'dba', 'dom', 'enchant', 'exif',
    'ffi', 'fileinfo', 'filter', 'ftp', 'gd', 'gettext', 'gmp', 'hash', 'iconv', 'imap', 'intl', 'json', 'ldap',
    'lexbor', 'libxml', 'mbstring', 'mysqli', 'mysqlnd', 'oci8', 'odbc', 'opcache', 'openssl', 'pcntl', 'pcre', 'pdo',
    'pdo_dblib', 'pdo_firebird', 'pdo_mysql', 'pdo_oci', 'pdo_odbc', 'pdo_pgsql', 'pdo_sqlite', 'pgsql',
    'phar', 'posix', 'pspell', 'random', 'readline', 'reflection', 'session', 'shmop', 'simplexml', 'snmp',
    'soap', 'sockets', 'sodium', 'spl', 'sqlite3', 'standard', 'sysvmsg', 'sysvsem', 'sysvshm', 'tidy',
    'tokenizer', 'uri', 'xml', 'xmlreader', 'xmlwriter', 'xsl', 'zend opcache', 'zip', 'zlib',
];
const KINDS = ['classes', 'functions', 'constants'];

/** Composer's platform package name of an extension (`PDO` → `ext-pdo`, `Zend OPcache` and ext/opcache → `ext-zend-opcache`). */
function platformName(string $ext): string
{
    $ext = strtolower($ext) === 'opcache' ? 'Zend OPcache' : $ext;
    return 'ext-' . strtolower(str_replace(' ', '-', $ext));
}

function bundled(?string $ext): bool
{
    return $ext !== null && $ext !== '' && in_array(strtolower($ext), BUNDLED, true);
}

function dump(): void
{
    $out = ['source' => 'reflection', 'version' => PHP_VERSION, 'extensions' => []];
    $add = function (?string $ext, string $kind, string $name) use (&$out) {
        if (bundled($ext)) $out['extensions'][platformName($ext)][$kind][] = $name;
    };
    foreach (array_merge(get_declared_classes(), get_declared_interfaces(), get_declared_traits()) as $class) {
        $r = new ReflectionClass($class);
        if ($r->isInternal()) $add($r->getExtensionName() ?: null, 'classes', $r->getName());
    }
    foreach (get_defined_functions()['internal'] as $function) {
        $r = new ReflectionFunction($function);
        $add($r->getExtensionName() ?: null, 'functions', $r->getName());
    }
    foreach (get_defined_constants(true) as $ext => $constants) {
        if ($ext !== 'user') foreach (array_keys($constants) as $name) $add($ext, 'constants', $name);
    }
    echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
}

/**
 * The top-level classes (interfaces, traits, enums), functions and constants a stub file declares,
 * with their namespace (`namespace Dom;` or a braced `namespace Dom { … }`).
 */
function stubDeclarations(string $code): array
{
    $tokens = PhpToken::tokenize($code);
    $out = ['classes' => [], 'functions' => [], 'constants' => []];
    $depth = 0;
    $namespace = '';
    $top = 0;
    $pendingNamespace = null;
    $n = count($tokens);
    $next = function (int $i) use ($tokens, $n): int {
        for ($j = $i + 1; $j < $n && $tokens[$j]->isIgnorable(); $j++);
        return $j;
    };
    for ($i = 0; $i < $n; $i++) {
        $t = $tokens[$i];
        if ($t->isIgnorable()) continue;
        if ($t->text === '{' || $t->is([T_CURLY_OPEN, T_DOLLAR_OPEN_CURLY_BRACES])) {
            $depth++;
            if ($pendingNamespace !== null) { $namespace = $pendingNamespace; $top = $depth; $pendingNamespace = null; }
            continue;
        }
        if ($t->text === '}') {
            if ($depth === $top && $top > 0) { $namespace = ''; $top = 0; }
            $depth--;
            continue;
        }
        if ($t->is(T_NAMESPACE) && $depth === 0) {
            $j = $next($i);
            $name = $tokens[$j]->is([T_STRING, T_NAME_QUALIFIED]) ? $tokens[$j]->text : '';
            $k = $tokens[$j]->text === '{' ? $j : $next($j);
            if ($tokens[$k]->text === '{') $pendingNamespace = $name;
            else { $namespace = $name; $top = 0; }
            continue;
        }
        if ($depth !== $top) continue;
        $qualify = fn (string $name) => $namespace === '' ? $name : "$namespace\\$name";
        if ($t->is([T_CLASS, T_INTERFACE, T_TRAIT, T_ENUM])) {
            // A declaration's keyword is followed by its name (`Foo::class` by none).
            $j = $next($i);
            if ($tokens[$j]->is(T_STRING)) $out['classes'][] = $qualify($tokens[$j]->text);
        } elseif ($t->is(T_FUNCTION)) {
            $j = $next($i);
            if ($tokens[$j]->text === '&') $j = $next($j);
            if ($tokens[$j]->is(T_STRING)) $out['functions'][] = $qualify($tokens[$j]->text);
        } elseif ($t->is(T_CONST)) {
            for ($j = $next($i); $j < $n && $tokens[$j]->text !== ';'; $j = $next($j)) {
                if ($tokens[$j]->is(T_STRING) && $tokens[$next($j)]->text === '=') $out['constants'][] = $qualify($tokens[$j]->text);
            }
        }
    }
    return $out;
}

function stubs(string $tag, string $dir): void
{
    $out = ['source' => 'stubs', 'version' => preg_replace('/^php-/', '', $tag), 'tag' => $tag, 'extensions' => []];
    foreach (glob("$dir/ext/*", GLOB_ONLYDIR) as $extDir) {
        $ext = basename($extDir);
        if (!bundled($ext)) continue;
        $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($extDir, FilesystemIterator::SKIP_DOTS));
        foreach ($files as $file) {
            $path = $file->getPathname();
            if (!str_ends_with($path, '.stub.php') || preg_match('#/tests?/#', $path)) continue;
            foreach (stubDeclarations(file_get_contents($path)) as $kind => $names) {
                foreach ($names as $name) $out['extensions'][platformName($ext)][$kind][] = $name;
            }
        }
    }
    echo json_encode($out, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
}

function merge(array $files): void
{
    $dumps = array_map(fn ($file) => json_decode(file_get_contents($file), true), $files);
    usort($dumps, fn ($a, $b) => version_compare($a['version'], $b['version']));
    // A name one extension defined and a later version moved (rand() from standard to random in
    // 8.2) belongs to the newest version's extension. Classes and functions are case-insensitive,
    // constants case-sensitive.
    $owner = [];
    foreach ($dumps as $data) {
        foreach ($data['extensions'] as $ext => $kinds) {
            foreach (KINDS as $kind) {
                foreach ($kinds[$kind] ?? [] as $name) $owner[$kind][$kind === 'constants' ? $name : strtolower($name)] = [$ext, $name];
            }
        }
    }
    $all = [];
    foreach ($owner as $kind => $names) {
        foreach ($names as [$ext, $name]) $all[$ext][$kind][] = $name;
    }
    ksort($all);
    $count = array_fill_keys(KINDS, 0);
    $body = '';
    foreach ($all as $ext => $kinds) {
        $body .= "  '$ext': {\n";
        foreach (KINDS as $kind) {
            $names = $kinds[$kind] ?? [];
            sort($names, SORT_STRING | SORT_FLAG_CASE);
            $count[$kind] += count($names);
            $body .= "    $kind: '" . str_replace('\\', '\\\\', implode(' ', $names)) . "',\n";
        }
        $body .= "  },\n";
    }
    $reflected = array_map(fn ($d) => $d['version'], array_filter($dumps, fn ($d) => $d['source'] === 'reflection'));
    $stubbed = array_map(fn ($d) => $d['tag'], array_filter($dumps, fn ($d) => $d['source'] === 'stubs'));
    $source = 'reflection of PHP ' . implode(', ', $reflected) . '; php-src stubs of ' . implode(', ', $stubbed) . ' (union, bundled extensions only)';
    echo "// Generated by scripts/gen-php-builtins.php (M5-21); do not edit. Regenerate with the commands in that script.\n";
    echo "// Source: $source:\n";
    echo "// {$count['classes']} classes, interfaces, traits and enums, {$count['functions']} functions, {$count['constants']} constants.\n\n";
    echo "/** Where the list comes from: the PHP versions reflected and the php-src tags whose stubs were read. */\n";
    echo "export const PHP_BUILTINS_SOURCE = '$source';\n\n";
    echo "/** By Composer platform package (`ext-pdo`): its classes, functions and constants, space-separated, as PHP spells them. */\n";
    echo "export const PHP_BUILTINS: Record<string, { classes: string; functions: string; constants: string }> = {\n$body};\n";
}

function pecl(): void
{
    $all = [];
    $add = function (?string $ext, string $kind, string $name) use (&$all) {
        if ($ext !== null && $ext !== '' && strtolower($ext) !== 'user' && !bundled($ext)) $all[platformName($ext)][$kind][] = $name;
    };
    foreach (array_merge(get_declared_classes(), get_declared_interfaces(), get_declared_traits()) as $class) {
        $r = new ReflectionClass($class);
        if ($r->isInternal()) $add($r->getExtensionName() ?: null, 'classes', $r->getName());
    }
    foreach (get_defined_functions()['internal'] as $function) {
        $r = new ReflectionFunction($function);
        $add($r->getExtensionName() ?: null, 'functions', $r->getName());
    }
    foreach (get_defined_constants(true) as $ext => $constants) {
        foreach (array_keys($constants) as $name) $add($ext, 'constants', $name);
    }
    ksort($all);
    $versions = [];
    $body = '';
    foreach ($all as $ext => $kinds) {
        $versions[] = substr($ext, 4) . ' ' . (phpversion(substr($ext, 4)) ?: '?');
        $body .= "  '$ext': {\n";
        foreach (KINDS as $kind) {
            $names = array_values(array_unique($kinds[$kind] ?? []));
            sort($names, SORT_STRING | SORT_FLAG_CASE);
            $body .= "    $kind: '" . str_replace('\\', '\\\\', implode(' ', $names)) . "',\n";
        }
        $body .= "  },\n";
    }
    $source = 'reflection of PHP ' . PHP_VERSION . ' with ' . implode(', ', $versions);
    echo "// Generated by scripts/gen-php-builtins.php pecl (M5-21-R1); do not edit. Regenerate with the command in that script.\n";
    echo "// Source: $source.\n\n";
    echo "/** Where the list comes from: the PHP reflected and each PECL extension's version. */\n";
    echo "export const PHP_PECL_SOURCE = '$source';\n\n";
    echo "/** PECL extensions by Composer platform package (`ext-redis`): their classes, functions and constants, space-separated, as PHP spells them. */\n";
    echo "export const PHP_PECL: Record<string, { classes: string; functions: string; constants: string }> = {\n$body};\n";
}

$mode = $argv[1] ?? '';
if ($mode === 'dump') dump();
elseif ($mode === 'stubs' && isset($argv[2], $argv[3])) stubs($argv[2], $argv[3]);
elseif ($mode === 'merge') merge(array_slice($argv, 2));
elseif ($mode === 'pecl') pecl();
else { fwrite(STDERR, "usage: php gen-php-builtins.php dump | stubs <tag> <php-src dir> | merge <dump.json>... | pecl\n"); exit(2); }
