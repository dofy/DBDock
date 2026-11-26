//! Decide when a protected SQL session can skip the confirmation dialog.
//! This is an accidental-write guard; the database role controls permissions.
use crate::store::Kind;

#[derive(Debug, PartialEq, Eq)]
enum Token<'a> {
    Word(&'a str),
    Quoted,
    Symbol(u8),
}

fn tokens(sql: &str, dialect: Kind) -> Option<Vec<Token<'_>>> {
    let bytes = sql.as_bytes();
    let mut result = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        let tail = &bytes[i..];
        if byte.is_ascii_whitespace() {
            i += 1;
        } else if (tail.starts_with(b"--")
            && (dialect != Kind::Mysql || tail.get(2).is_none_or(u8::is_ascii_whitespace)))
            || (byte == b'#' && dialect == Kind::Mysql)
        {
            i += tail
                .iter()
                .position(|b| matches!(b, b'\n' | b'\r'))
                .unwrap_or(tail.len());
        } else if let Some(comment) = tail.strip_prefix(b"/*") {
            // MySQL and MariaDB can execute the contents of versioned comments.
            if comment.starts_with(b"!")
                || comment
                    .get(..2)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"M!"))
            {
                return None;
            }
            let end = comment
                .windows(2)
                .position(|pair| pair == b"*/" || pair == b"/*")?;
            if &comment[end..end + 2] != b"*/" {
                return None;
            }
            i += end + 4;
        } else if matches!(byte, b'\'' | b'"') || (byte == b'`' && dialect != Kind::Postgres) {
            i += 1;
            loop {
                let current = *bytes.get(i)?;
                i += 1;
                // Backslashes may change the quote boundary depending on session settings.
                if matches!(current, b'\\' | 0) {
                    return None;
                }
                if current == byte {
                    if bytes.get(i) == Some(&byte) {
                        i += 1;
                    } else {
                        break;
                    }
                }
            }
            result.push(Token::Quoted);
        } else if byte.is_ascii_alphanumeric() || byte == b'_' {
            let start = i;
            while bytes
                .get(i)
                .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_')
            {
                i += 1;
            }
            result.push(Token::Word(&sql[start..i]));
        } else if b"().,;*+-/%<>=!:?|&^~".contains(&byte) && !tail.starts_with(b":=") {
            result.push(Token::Symbol(byte));
            i += 1;
        } else {
            // Includes dollar quoting, unquoted non-ASCII names and user variables.
            return None;
        }
    }
    Some(result)
}

fn ordinary_read(statement: &[Token<'_>]) -> bool {
    let words: Vec<_> = statement
        .iter()
        .map(|token| match token {
            Token::Word(word) => word.to_ascii_uppercase(),
            _ => String::new(),
        })
        .collect();
    let first = words.first().map(String::as_str);
    let explain = first == Some("EXPLAIN");
    match first {
        Some("SELECT" | "WITH" | "SHOW") => {}
        Some("EXPLAIN")
            if words
                .get(1)
                .is_some_and(|word| word == "SELECT" || word == "WITH") => {}
        _ => return false,
    }

    let mut nesting = 0;
    let mut has_top_level_select = false;
    for (i, token) in statement.iter().enumerate() {
        let word = words[i].as_str();
        if matches!(
            word,
            "INSERT"
                | "UPDATE"
                | "DELETE"
                | "MERGE"
                | "REPLACE"
                | "UPSERT"
                | "COPY"
                | "INTO"
                | "LOCK"
                | "CALL"
                | "DO"
                | "CREATE"
                | "ALTER"
                | "DROP"
                | "TRUNCATE"
                | "ATTACH"
                | "DETACH"
                | "SET"
                | "ANALYZE"
                | "ANALYSE"
                | "GRANT"
                | "REVOKE"
                | "REFRESH"
                | "EXECUTE"
                | "VACUUM"
        ) {
            return false;
        }
        if word == "FOR"
            && words
                .get(i + 1)
                .is_some_and(|next| next == "SHARE" || next == "KEY")
        {
            return false;
        }
        if word == "SELECT" && nesting == 0 {
            has_top_level_select = true;
        }
        match token {
            Token::Symbol(b'(') => {
                nesting += 1;
                let Some(previous) = i.checked_sub(1) else {
                    continue;
                };
                if statement[previous] == Token::Quoted {
                    return false;
                }
                if let Token::Word(_) = statement[previous] {
                    let syntax = matches!(
                        words[previous].as_str(),
                        "SELECT"
                            | "DISTINCT"
                            | "AS"
                            | "FROM"
                            | "WHERE"
                            | "JOIN"
                            | "ON"
                            | "IN"
                            | "EXISTS"
                            | "AND"
                            | "OR"
                            | "NOT"
                            | "WHEN"
                            | "THEN"
                            | "ELSE"
                            | "BY"
                            | "HAVING"
                            | "OVER"
                            | "FILTER"
                            | "ALL"
                            | "ANY"
                            | "SOME"
                    );
                    let builtin = matches!(
                        words[previous].as_str(),
                        "COUNT"
                            | "SUM"
                            | "AVG"
                            | "MIN"
                            | "MAX"
                            | "COALESCE"
                            | "NULLIF"
                            | "ABS"
                            | "ROUND"
                            | "LENGTH"
                            | "CHAR_LENGTH"
                            | "LOWER"
                            | "UPPER"
                            | "TRIM"
                            | "SUBSTRING"
                            | "SUBSTR"
                            | "CONCAT"
                            | "CAST"
                            | "EXTRACT"
                            | "DATE"
                            | "DATE_TRUNC"
                            | "NOW"
                            | "ROW_NUMBER"
                            | "RANK"
                            | "DENSE_RANK"
                            | "LAG"
                            | "LEAD"
                            | "FIRST_VALUE"
                            | "LAST_VALUE"
                            | "STRING_AGG"
                            | "GROUP_CONCAT"
                            | "ARRAY_AGG"
                            | "JSON_AGG"
                            | "JSONB_AGG"
                    );
                    let qualified = previous
                        .checked_sub(1)
                        .is_some_and(|j| statement[j] == Token::Symbol(b'.'));
                    if qualified || !(syntax || builtin) {
                        return false;
                    }
                }
            }
            Token::Symbol(b')') => {
                nesting -= 1;
                if nesting < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    nesting == 0
        && (first == Some("SHOW") || (!explain && first == Some("SELECT")) || has_top_level_select)
}

pub fn needs_confirmation(sql: &str, dialect: Kind) -> bool {
    let Some(tokens) = tokens(sql, dialect) else {
        return true;
    };
    let mut any = false;
    for statement in tokens
        .split(|token| *token == Token::Symbol(b';'))
        .filter(|statement| !statement.is_empty())
    {
        any = true;
        if !ordinary_read(statement) {
            return true;
        }
    }
    !any
}

/// Only rerun raw predicates automatically when they form one recognized read.
pub(crate) fn is_single_read(sql: &str, dialect: Kind) -> bool {
    tokens(sql, dialect).is_some_and(|tokens| {
        !tokens.contains(&Token::Symbol(b';')) && ordinary_read(&tokens)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_reads_skip_confirmation() {
        for sql in [
            "SELECT * FROM posts WHERE id = 42",
            " -- note\nSELECT COUNT(*) FROM posts; SELECT 'UPDATE; DELETE' AS label",
            "WITH recent AS (SELECT id FROM posts) SELECT MAX(id) FROM recent",
            "EXPLAIN SELECT * FROM posts",
            "SHOW TABLES",
            "SELECT * FROM posts WHERE id IN (SELECT id FROM other)",
            "SELECT 'it''s a string', \"column\" FROM \"table\"",
        ] {
            assert!(!needs_confirmation(sql, Kind::Postgres), "{sql}");
        }
    }

    #[test]
    fn writes_locks_and_ambiguous_statements_require_confirmation() {
        for sql in [
            "UPDATE posts SET id = 1",
            "select 1; delete from posts",
            "WITH changed AS (DELETE FROM posts RETURNING *) SELECT * FROM changed",
            "SELECT * FROM posts FOR UPDATE",
            "SELECT * FROM posts FOR SHARE",
            "SELECT * FROM posts FOR KEY SHARE",
            "SELECT * INTO archive FROM posts",
            "SELECT nextval('ids')",
            "SELECT pg_advisory_lock(1)",
            "SELECT custom.count(*) FROM posts",
            "SELECT \"custom_function\"()",
            "EXPLAIN ANALYZE SELECT * FROM posts",
            "SELECT $$ambiguous$$",
            "SELECT 'unterminated",
            "SELECT 1 /* outer /* nested */ */",
        ] {
            assert!(needs_confirmation(sql, Kind::Postgres), "{sql}");
        }
        for sql in [
            "SELECT 1; /*!50000 UPDATE posts SET id=2 */",
            "SELECT 1; /*M! UPDATE posts SET id=2 */",
            "SELECT 1--2; UPDATE posts SET id=2",
            "SELECT \"label\" INTO OUTFILE '/tmp/result'",
            "SELECT @counter := 1",
        ] {
            assert!(needs_confirmation(sql, Kind::Mysql), "{sql}");
        }
        assert!(!needs_confirmation(
            "# comment\nSELECT id FROM `posts`",
            Kind::Mysql
        ));
    }
}
