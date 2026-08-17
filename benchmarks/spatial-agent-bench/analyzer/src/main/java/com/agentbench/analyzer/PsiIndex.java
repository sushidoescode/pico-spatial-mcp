package com.agentbench.analyzer;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import org.jetbrains.kotlin.cli.common.CLIConfigurationKeys;
import org.jetbrains.kotlin.cli.common.messages.MessageCollector;
import org.jetbrains.kotlin.cli.jvm.compiler.EnvironmentConfigFiles;
import org.jetbrains.kotlin.cli.jvm.compiler.KotlinCoreEnvironment;
import org.jetbrains.kotlin.com.intellij.openapi.Disposable;
import org.jetbrains.kotlin.com.intellij.openapi.util.TextRange;
import org.jetbrains.kotlin.com.intellij.psi.PsiElement;
import org.jetbrains.kotlin.com.intellij.psi.PsiErrorElement;
import org.jetbrains.kotlin.com.intellij.psi.tree.IElementType;
import org.jetbrains.kotlin.com.intellij.psi.util.PsiTreeUtil;
import org.jetbrains.kotlin.config.CommonConfigurationKeys;
import org.jetbrains.kotlin.config.CompilerConfiguration;
import org.jetbrains.kotlin.lexer.KtTokens;
import org.jetbrains.kotlin.psi.KtAnnotated;
import org.jetbrains.kotlin.psi.KtAnnotationEntry;
import org.jetbrains.kotlin.psi.KtArrayAccessExpression;
import org.jetbrains.kotlin.psi.KtBinaryExpression;
import org.jetbrains.kotlin.psi.KtBinaryExpressionWithTypeRHS;
import org.jetbrains.kotlin.psi.KtBlockExpression;
import org.jetbrains.kotlin.psi.KtBreakExpression;
import org.jetbrains.kotlin.psi.KtCallExpression;
import org.jetbrains.kotlin.psi.KtCallableReferenceExpression;
import org.jetbrains.kotlin.psi.KtCatchClause;
import org.jetbrains.kotlin.psi.KtClass;
import org.jetbrains.kotlin.psi.KtClassLiteralExpression;
import org.jetbrains.kotlin.psi.KtClassOrObject;
import org.jetbrains.kotlin.psi.KtConstantExpression;
import org.jetbrains.kotlin.psi.KtConstructorCalleeExpression;
import org.jetbrains.kotlin.psi.KtContinueExpression;
import org.jetbrains.kotlin.psi.KtDoubleColonExpression;
import org.jetbrains.kotlin.psi.KtDotQualifiedExpression;
import org.jetbrains.kotlin.psi.KtExpression;
import org.jetbrains.kotlin.psi.KtExpressionWithLabel;
import org.jetbrains.kotlin.psi.KtFile;
import org.jetbrains.kotlin.psi.KtForExpression;
import org.jetbrains.kotlin.psi.KtIfExpression;
import org.jetbrains.kotlin.psi.KtImportDirective;
import org.jetbrains.kotlin.psi.KtLabeledExpression;
import org.jetbrains.kotlin.psi.KtLambdaExpression;
import org.jetbrains.kotlin.psi.KtModifierListOwner;
import org.jetbrains.kotlin.psi.KtNameReferenceExpression;
import org.jetbrains.kotlin.psi.KtNamedDeclaration;
import org.jetbrains.kotlin.psi.KtNamedFunction;
import org.jetbrains.kotlin.psi.KtNullableType;
import org.jetbrains.kotlin.psi.KtObjectDeclaration;
import org.jetbrains.kotlin.psi.KtPackageDirective;
import org.jetbrains.kotlin.psi.KtParameter;
import org.jetbrains.kotlin.psi.KtParenthesizedExpression;
import org.jetbrains.kotlin.psi.KtPostfixExpression;
import org.jetbrains.kotlin.psi.KtPrefixExpression;
import org.jetbrains.kotlin.psi.KtProperty;
import org.jetbrains.kotlin.psi.KtQualifiedExpression;
import org.jetbrains.kotlin.psi.KtReturnExpression;
import org.jetbrains.kotlin.psi.KtSafeQualifiedExpression;
import org.jetbrains.kotlin.psi.KtStringTemplateEntry;
import org.jetbrains.kotlin.psi.KtStringTemplateExpression;
import org.jetbrains.kotlin.psi.KtSuperTypeCallEntry;
import org.jetbrains.kotlin.psi.KtSuperTypeListEntry;
import org.jetbrains.kotlin.psi.KtThisExpression;
import org.jetbrains.kotlin.psi.KtTryExpression;
import org.jetbrains.kotlin.psi.KtTypeElement;
import org.jetbrains.kotlin.psi.KtTypeProjection;
import org.jetbrains.kotlin.psi.KtTypeReference;
import org.jetbrains.kotlin.psi.KtUnaryExpression;
import org.jetbrains.kotlin.psi.KtUserType;
import org.jetbrains.kotlin.psi.KtValueArgument;
import org.jetbrains.kotlin.psi.KtValueArgumentName;
import org.jetbrains.kotlin.psi.KtWhenCondition;
import org.jetbrains.kotlin.psi.KtWhenConditionInRange;
import org.jetbrains.kotlin.psi.KtWhenConditionIsPattern;
import org.jetbrains.kotlin.psi.KtWhenConditionWithExpression;
import org.jetbrains.kotlin.psi.KtWhenEntry;
import org.jetbrains.kotlin.psi.KtWhenExpression;
import org.jetbrains.kotlin.psi.KtWhileExpressionBase;
import org.jetbrains.kotlin.psi.KtPsiFactory;
import org.jetbrains.kotlin.resolve.ImportPath;
import org.jetbrains.kotlin.com.intellij.openapi.util.Disposer;

final class PsiIndex {
    record Source(String path, String sha256, String content) {
        Source {
            requireText(path, "source path");
            if (!isHash(sha256)) throw new IllegalArgumentException("source sha256 is invalid");
            Objects.requireNonNull(content, "source content");
        }
    }

    enum NodeKind {
        FILE, CLASS_DECL, INTERFACE_DECL, OBJECT_DECL, COMPANION_DECL, FUNCTION_DECL, PROPERTY_DECL,
        PARAMETER_DECL, TYPE_REF, BLOCK, CALL, ARGUMENT, NAME_REF, THIS_REF, QUALIFIED,
        SAFE_QUALIFIED, CALLABLE_REF, CLASS_LITERAL, LAMBDA, ASSIGNMENT, BINARY, PREFIX,
        POSTFIX, INDEX_ACCESS, IF, WHEN, WHEN_ENTRY, TRY, CATCH, RETURN, BREAK, CONTINUE,
        FOR, WHILE, ANNOTATION, STRING_TEMPLATE, LITERAL
    }

    enum NodeFlag {
        DATA, SEALED, CONST, VAL, VAR, SUSPEND, OVERRIDE, PRIVATE, EXPRESSION_BODY, NAMED,
        SAFE, LABELED
    }

    enum EdgeRole {
        FILE_MEMBER, LEXICAL_OWNER, RECEIVER, CALLEE, ARGUMENT, TYPE_ARGUMENT, PARAMETER,
        TYPE, ANNOTATION, SUPER_TYPE, DEFAULT_VALUE, INITIALIZER, BODY, CONDITION,
        THEN_BRANCH, ELSE_BRANCH, SUBJECT, ENTRY, LEFT, RIGHT, OPERAND, TARGET, VALUE,
        SELECTOR, INDEX, RANGE, LOOP_BODY, TRY_BODY, CATCH_CLAUSE, CATCH_BODY,
        RETURN_VALUE, LAMBDA_BODY, STRING_EXPRESSION
    }

    enum TokenKind {
        IDENTIFIER, KEYWORD, OPERATOR, STRING_LITERAL, INTEGER_LITERAL, FLOAT_LITERAL,
        BOOLEAN_LITERAL, NULL_LITERAL
    }

    enum WitnessKind {
        DECLARATION, CALLABLE_REFERENCE, CALL, ARGUMENT, PROPERTY_READ, ASSIGNMENT,
        CONDITION, LOOP, LAMBDA, RETURN, TYPE_REFERENCE, CATCH
    }

    record FileUnit(int id, String path, String sha256, int utf16Length, String packageName,
            List<Integer> importIds) {
        FileUnit {
            if (id < 0 || utf16Length < 0) throw new IllegalArgumentException("invalid file scalar");
            requireText(path, "file path");
            if (!isHash(sha256)) throw new IllegalArgumentException("invalid file sha256");
            Objects.requireNonNull(packageName, "package name");
            importIds = List.copyOf(importIds);
        }
    }

    record ImportEntry(int id, int fileId, String fqName, String exposedName, String alias,
            int syntaxNodeId, String witnessNodeId) {
        ImportEntry {
            if (id < 0 || fileId < 0 || syntaxNodeId < 0) throw new IllegalArgumentException("invalid import scalar");
            requireText(fqName, "import fqName");
            requireText(exposedName, "import exposedName");
            if (alias != null) requireText(alias, "import alias");
            if (witnessNodeId != null && !isHash(witnessNodeId)) throw new IllegalArgumentException("invalid import witness");
        }
    }

    record Token(int id, int fileId, int startUtf16, int endUtf16, TokenKind kind, String value,
            String textSha256, boolean structuralToken) {
        Token {
            if (id < 0 || fileId < 0 || startUtf16 < 0 || endUtf16 <= startUtf16) {
                throw new IllegalArgumentException("invalid token scalar");
            }
            Objects.requireNonNull(kind, "token kind");
            Objects.requireNonNull(value, "token value");
            if (!isHash(textSha256)) throw new IllegalArgumentException("invalid token hash");
        }
    }

    record Node(int id, int fileId, NodeKind kind, int startUtf16, int endUtf16,
            int firstTokenId, int tokenCount, String name, String value, List<NodeFlag> flags,
            String witnessNodeId) {
        Node {
            if (id < 0 || fileId < 0 || startUtf16 < 0 || endUtf16 < startUtf16
                    || firstTokenId < 0 || tokenCount < 0) throw new IllegalArgumentException("invalid node scalar");
            Objects.requireNonNull(kind, "node kind");
            flags = List.copyOf(flags);
            if (witnessNodeId != null && !isHash(witnessNodeId)) throw new IllegalArgumentException("invalid node witness");
            int prior = -1;
            for (NodeFlag flag : flags) {
                if (flag.ordinal() <= prior) throw new IllegalArgumentException("node flags are not canonical");
                prior = flag.ordinal();
            }
        }
    }

    record Edge(int fromNodeId, EdgeRole role, int ordinal, int toNodeId) {
        Edge {
            if (fromNodeId < 0 || ordinal < 0 || toNodeId < 0) throw new IllegalArgumentException("invalid edge scalar");
            Objects.requireNonNull(role, "edge role");
        }
    }

    record WitnessNode(String nodeId, int fileId, int startUtf16, int endUtf16, WitnessKind kind,
            String textSha256, boolean structuralToken) {
        WitnessNode {
            if (!isHash(nodeId) || !isHash(textSha256) || fileId < 0 || startUtf16 < 0 || endUtf16 <= startUtf16) {
                throw new IllegalArgumentException("invalid witness scalar");
            }
            Objects.requireNonNull(kind, "witness kind");
            if (!structuralToken && kind != WitnessKind.ARGUMENT) {
                throw new IllegalArgumentException("only argument witnesses may be literal-only");
            }
        }
    }

    record Program(int psiNodeCount, int declarationCount, int callSiteCount,
            List<FileUnit> files, List<ImportEntry> imports, List<Token> tokens, List<Node> nodes,
            List<Edge> edges, List<WitnessNode> witnesses) {
        Program {
            files = List.copyOf(files);
            imports = List.copyOf(imports);
            tokens = List.copyOf(tokens);
            nodes = List.copyOf(nodes);
            edges = List.copyOf(edges);
            witnesses = List.copyOf(witnesses);
            validateProgram(psiNodeCount, declarationCount, callSiteCount,
                files, imports, tokens, nodes, edges, witnesses);
        }

        FileUnit file(int id) {
            if (id < 0 || id >= files.size() || files.get(id).id() != id) throw new IllegalArgumentException("unknown file id");
            return files.get(id);
        }

        Node node(int id) {
            if (id < 0 || id >= nodes.size() || nodes.get(id).id() != id) throw new IllegalArgumentException("unknown node id");
            return nodes.get(id);
        }

        WitnessNode witness(String nodeId) {
            requireText(nodeId, "witness id");
            int low = 0;
            int high = witnesses.size();
            while (low < high) {
                int middle = (low + high) >>> 1;
                int order = Protocol.compareUtf8(witnesses.get(middle).nodeId(), nodeId);
                if (order < 0) low = middle + 1;
                else high = middle;
            }
            if (low >= witnesses.size() || !witnesses.get(low).nodeId().equals(nodeId)) {
                throw new IllegalArgumentException("unknown witness id");
            }
            return witnesses.get(low);
        }
    }

    static final class SnapshotRejected extends RuntimeException {
        private final String rejectionCode;

        SnapshotRejected(String rejectionCode) {
            super(rejectionCode);
            if (!isSnapshotRejection(rejectionCode)) throw new IllegalArgumentException("invalid snapshot rejection");
            this.rejectionCode = rejectionCode;
        }

        String rejectionCode() { return rejectionCode; }
    }

    record Result(String rejectionCode, List<Map<String, Object>> nodes, List<Map<String, Object>> claims) {
        Result {
            if (rejectionCode == null) {
                Rules.Analysis validated = new Rules.Analysis(nodes, claims);
                nodes = validated.nodes();
                claims = validated.claims();
            } else {
                nodes = List.copyOf(nodes);
                claims = List.copyOf(claims);
                if (!isKnownRejection(rejectionCode) || !nodes.isEmpty() || !claims.isEmpty()) {
                    throw new IllegalArgumentException("invalid rejected result");
                }
            }
        }

        static Result accepted(Rules.Analysis analysis) {
            Objects.requireNonNull(analysis, "analysis");
            return new Result(null, analysis.nodes(), analysis.claims());
        }

        static Result rejected(String code) { return new Result(code, List.of(), List.of()); }
    }

    private PsiIndex() {}

    static Result analyze(List<Source> sources) {
        try {
            Program program = snapshot(sources);
            return Result.accepted(Rules.analyze(program));
        } catch (SnapshotRejected rejected) {
            return Result.rejected(rejected.rejectionCode());
        } catch (Throwable uncertainty) {
            return Result.rejected("internal_uncertainty");
        }
    }

    static Program snapshot(List<Source> rawSources) {
        List<Source> sources = List.copyOf(rawSources);
        Disposable disposable = Disposer.newDisposable("agentbench-kotlin-psi-v1");
        try {
            CompilerConfiguration configuration = new CompilerConfiguration();
            configuration.put(CLIConfigurationKeys.MESSAGE_COLLECTOR_KEY, MessageCollector.Companion.getNONE());
            configuration.put(CommonConfigurationKeys.MODULE_NAME, "agentbench-analyzer-v1");
            KotlinCoreEnvironment environment = KotlinCoreEnvironment.createForProduction(
                disposable, configuration, EnvironmentConfigFiles.JVM_CONFIG_FILES);
            KtPsiFactory factory = new KtPsiFactory(environment.getProject(), false);
            List<FileUnit> files = new ArrayList<>();
            List<ImportEntry> imports = new ArrayList<>();
            List<Token> tokens = new ArrayList<>();
            List<PsiElement> semanticElements = new ArrayList<>();
            List<Integer> semanticFileIds = new ArrayList<>();
            List<Edge> edges = new ArrayList<>();
            IdentityHashMap<PsiElement, Integer> nodeIds = new IdentityHashMap<>();
            Map<Integer, Integer> lexicalOrdinals = new HashMap<>();
            Map<String, String> declarations = new HashMap<>();
            List<String> contents = new ArrayList<>();
            List<String> paths = new ArrayList<>();
            List<String> hashes = new ArrayList<>();
            int psiNodes = 0;
            int declarationCount = 0;
            int callSites = 0;
            String previousPath = null;

            for (int fileId = 0; fileId < sources.size(); fileId++) {
                Source source = sources.get(fileId);
                if (previousPath != null && Protocol.compareUtf8(previousPath, source.path()) >= 0) {
                    throw new IllegalArgumentException("sources are duplicated or out of order");
                }
                previousPath = source.path();
                if (!Protocol.sha256(source.content().getBytes(StandardCharsets.UTF_8)).equals(source.sha256())) {
                    throw new IllegalArgumentException("source hash changed before snapshot");
                }
                KtFile file = factory.createFile(source.path(), source.content());
                if (!file.getText().equals(source.content())) throw new IllegalArgumentException("PSI source text mismatch");
                if (PsiTreeUtil.hasErrorElements(file)) throw new SnapshotRejected("parse");
                if (!importsComplete(file)) throw new SnapshotRejected("incomplete_imports");
                contents.add(source.content());
                paths.add(source.path());
                hashes.add(source.sha256());
                int nodeBase = semanticElements.size();
                ArrayDeque<PsiElement> pending = new ArrayDeque<>();
                ArrayDeque<Integer> owners = new ArrayDeque<>();
                pending.push(file);
                owners.push(-1);
                while (!pending.isEmpty()) {
                    PsiElement element = pending.pop();
                    int owner = owners.pop();
                    if (++psiNodes > Main.MAX_PSI_NODES) throw new SnapshotRejected("limit");
                    if (element instanceof PsiErrorElement) throw new SnapshotRejected("parse");
                    if (element instanceof KtCallExpression && ++callSites > Main.MAX_CALL_SITES) {
                        throw new SnapshotRejected("limit");
                    }
                    if (element instanceof KtNamedDeclaration named && named.getName() != null) {
                        if (++declarationCount > Main.MAX_DECLARATIONS) throw new SnapshotRejected("limit");
                        String key = declarationKey(file, named);
                        if (declarations.putIfAbsent(key, source.path()) != null) {
                            throw new SnapshotRejected("ambiguous_index");
                        }
                    }
                    NodeKind nodeKind = nodeKind(element);
                    int childOwner = owner;
                    if (nodeKind != null) {
                        int nodeId = semanticElements.size();
                        semanticElements.add(element);
                        semanticFileIds.add(fileId);
                        nodeIds.put(element, nodeId);
                        if (owner >= 0) {
                            int ordinal = lexicalOrdinals.getOrDefault(owner, 0);
                            edges.add(new Edge(owner, EdgeRole.LEXICAL_OWNER, ordinal, nodeId));
                            lexicalOrdinals.put(owner, ordinal + 1);
                        }
                        childOwner = nodeId;
                    }
                    PsiElement lastChild = element.getLastChild();
                    if (lastChild == null) {
                        TokenKind tokenKind = tokenKind(element);
                        if (tokenKind != null) {
                            TextRange range = checkedRange(element, source.content());
                            String text = range.substring(source.content());
                            boolean structural = tokenKind == TokenKind.IDENTIFIER || tokenKind == TokenKind.KEYWORD
                                || tokenKind == TokenKind.OPERATOR;
                            tokens.add(new Token(tokens.size(), fileId, range.getStartOffset(), range.getEndOffset(),
                                tokenKind, text, Protocol.sha256(text.getBytes(StandardCharsets.UTF_8)), structural));
                        }
                    }
                    for (PsiElement child = lastChild; child != null; child = child.getPrevSibling()) {
                        pending.push(child);
                        owners.push(childOwner);
                    }
                }
                for (int nodeId = nodeBase; nodeId < semanticElements.size(); nodeId++) {
                    addTypedEdges(nodeId, semanticElements.get(nodeId), nodeIds, edges);
                }
                List<Integer> importIds = new ArrayList<>();
                for (KtImportDirective directive : file.getImportDirectives()) {
                    ImportPath imported = directive.getImportPath();
                    String alias = directive.getAliasName();
                    String exposed = alias == null ? imported.getImportedName().asString() : alias;
                    Integer syntaxNodeId = nodeIds.get(directive.getImportedReference());
                    if (syntaxNodeId == null) throw new SnapshotRejected("incomplete_imports");
                    int importId = imports.size();
                    imports.add(new ImportEntry(importId, fileId, imported.getFqName().asString(), exposed,
                        alias, syntaxNodeId, null));
                    importIds.add(importId);
                }
                files.add(new FileUnit(fileId, source.path(), source.sha256(), source.content().length(),
                    file.getPackageFqName().asString(), importIds));
            }

            edges.sort(PsiIndex::compareEdges);
            List<Node> nodes = new ArrayList<>();
            List<WitnessNode> witnesses = new ArrayList<>();
            for (int nodeId = 0; nodeId < semanticElements.size(); nodeId++) {
                PsiElement element = semanticElements.get(nodeId);
                int fileId = semanticFileIds.get(nodeId);
                String content = contents.get(fileId);
                TextRange range = checkedRange(element, content);
                int firstToken = lowerBoundToken(tokens, fileId, range.getStartOffset());
                int tokenCount = 0;
                boolean structural = false;
                for (int index = firstToken; index < tokens.size(); index++) {
                    Token token = tokens.get(index);
                    if (token.fileId() != fileId || token.startUtf16() >= range.getEndOffset()) break;
                    if (token.endUtf16() > range.getEndOffset()) throw new IllegalArgumentException("token crosses node span");
                    tokenCount++;
                    structural |= token.structuralToken();
                }
                WitnessKind witnessKind = witnessKind(element);
                String witnessId = null;
                if (witnessKind != null && (structural || witnessKind == WitnessKind.ARGUMENT)) {
                    String text = range.substring(content);
                    String textHash = Protocol.sha256(text.getBytes(StandardCharsets.UTF_8));
                    Map<String, Object> identity = Map.of(
                        "path", paths.get(fileId), "fileSha256", hashes.get(fileId),
                        "startUtf16", range.getStartOffset(), "endUtf16", range.getEndOffset(),
                        "kind", witnessKindName(witnessKind), "textSha256", textHash,
                        "structuralToken", structural);
                    witnessId = Protocol.sha256(Protocol.canonicalBytes(identity));
                    witnesses.add(new WitnessNode(witnessId, fileId, range.getStartOffset(), range.getEndOffset(),
                        witnessKind, textHash, structural));
                }
                nodes.add(new Node(nodeId, fileId, nodeKind(element), range.getStartOffset(), range.getEndOffset(),
                    firstToken, tokenCount, nodeName(element), nodeValue(element), nodeFlags(element), witnessId));
            }
            for (int importId = 0; importId < imports.size(); importId++) {
                ImportEntry entry = imports.get(importId);
                String witnessId = nodes.get(entry.syntaxNodeId()).witnessNodeId();
                if (witnessId == null) throw new SnapshotRejected("incomplete_imports");
                imports.set(importId, new ImportEntry(entry.id(), entry.fileId(), entry.fqName(), entry.exposedName(),
                    entry.alias(), entry.syntaxNodeId(), witnessId));
            }
            witnesses.sort((left, right) -> Protocol.compareUtf8(left.nodeId(), right.nodeId()));
            return new Program(psiNodes, declarationCount, callSites, files, imports, tokens, nodes, edges, witnesses);
        } finally {
            Disposer.dispose(disposable);
        }
    }

    private static boolean importsComplete(KtFile file) {
        Map<String, String> exposed = new HashMap<>();
        for (KtImportDirective directive : file.getImportDirectives()) {
            ImportPath imported = directive.getImportPath();
            if (imported == null || !directive.isValidImport() || imported.isAllUnder() || imported.getImportedName() == null) return false;
            String alias = directive.getAliasName();
            String name = alias == null ? imported.getImportedName().asString() : alias;
            String prior = exposed.putIfAbsent(name, imported.getFqName().asString());
            if (prior != null && !prior.equals(imported.getFqName().asString())) return false;
        }
        return true;
    }

    private static String declarationKey(KtFile file, KtNamedDeclaration declaration) {
        StringBuilder scope = new StringBuilder(file.getPackageFqName().asString());
        ArrayDeque<String> owners = new ArrayDeque<>();
        PsiElement parent = declaration.getParent();
        while (parent != null && parent != file) {
            if (parent instanceof KtNamedDeclaration named && named.getName() != null) owners.push(named.getName());
            parent = parent.getParent();
        }
        while (!owners.isEmpty()) scope.append('/').append(owners.pop());
        return scope.append('#').append(declaration.getName()).toString();
    }

    private static NodeKind nodeKind(PsiElement element) {
        if (element instanceof KtFile) return NodeKind.FILE;
        if (element instanceof KtClass klass) return klass.isInterface() ? NodeKind.INTERFACE_DECL : NodeKind.CLASS_DECL;
        if (element instanceof KtObjectDeclaration object) return object.isCompanion() ? NodeKind.COMPANION_DECL : NodeKind.OBJECT_DECL;
        if (element instanceof KtNamedFunction) return NodeKind.FUNCTION_DECL;
        if (element instanceof KtProperty) return NodeKind.PROPERTY_DECL;
        if (element instanceof KtParameter) return NodeKind.PARAMETER_DECL;
        if (element instanceof KtSuperTypeCallEntry) return NodeKind.TYPE_REF;
        if (element instanceof KtTypeProjection projection && projection.getTypeReference() == null) return NodeKind.TYPE_REF;
        if (element instanceof KtTypeReference) return NodeKind.TYPE_REF;
        if (element instanceof KtBlockExpression) return NodeKind.BLOCK;
        if (element instanceof KtCallExpression) return NodeKind.CALL;
        if (element instanceof KtValueArgument) return NodeKind.ARGUMENT;
        if (element instanceof KtNameReferenceExpression) return NodeKind.NAME_REF;
        if (element instanceof KtThisExpression) return NodeKind.THIS_REF;
        if (element instanceof KtSafeQualifiedExpression) return NodeKind.SAFE_QUALIFIED;
        if (element instanceof KtDotQualifiedExpression) return NodeKind.QUALIFIED;
        if (element instanceof KtCallableReferenceExpression) return NodeKind.CALLABLE_REF;
        if (element instanceof KtClassLiteralExpression) return NodeKind.CLASS_LITERAL;
        if (element instanceof KtLambdaExpression) return NodeKind.LAMBDA;
        if (element instanceof KtBinaryExpression binary) {
            return KtTokens.ALL_ASSIGNMENTS.contains(binary.getOperationToken()) ? NodeKind.ASSIGNMENT : NodeKind.BINARY;
        }
        if (element instanceof KtBinaryExpressionWithTypeRHS) return NodeKind.BINARY;
        if (element instanceof KtPrefixExpression) return NodeKind.PREFIX;
        if (element instanceof KtPostfixExpression) return NodeKind.POSTFIX;
        if (element instanceof KtArrayAccessExpression) return NodeKind.INDEX_ACCESS;
        if (element instanceof KtIfExpression) return NodeKind.IF;
        if (element instanceof KtWhenExpression) return NodeKind.WHEN;
        if (element instanceof KtWhenEntry) return NodeKind.WHEN_ENTRY;
        if (element instanceof KtTryExpression) return NodeKind.TRY;
        if (element instanceof KtCatchClause) return NodeKind.CATCH;
        if (element instanceof KtReturnExpression) return NodeKind.RETURN;
        if (element instanceof KtBreakExpression) return NodeKind.BREAK;
        if (element instanceof KtContinueExpression) return NodeKind.CONTINUE;
        if (element instanceof KtForExpression) return NodeKind.FOR;
        if (element instanceof KtWhileExpressionBase) return NodeKind.WHILE;
        if (element instanceof KtAnnotationEntry) return NodeKind.ANNOTATION;
        if (element instanceof KtStringTemplateExpression) return NodeKind.STRING_TEMPLATE;
        if (element instanceof KtConstantExpression) return NodeKind.LITERAL;
        return null;
    }

    private static TokenKind tokenKind(PsiElement element) {
        if (element.getNode() == null) return null;
        IElementType type = element.getNode().getElementType();
        if (type == KtTokens.INTEGER_LITERAL) return TokenKind.INTEGER_LITERAL;
        if (type == KtTokens.FLOAT_LITERAL) return TokenKind.FLOAT_LITERAL;
        if (type == KtTokens.TRUE_KEYWORD || type == KtTokens.FALSE_KEYWORD) return TokenKind.BOOLEAN_LITERAL;
        if (type == KtTokens.NULL_KEYWORD) return TokenKind.NULL_LITERAL;
        if (type == KtTokens.OPEN_QUOTE || type == KtTokens.CLOSING_QUOTE
                || type == KtTokens.REGULAR_STRING_PART || type == KtTokens.ESCAPE_SEQUENCE) return TokenKind.STRING_LITERAL;
        if (type == KtTokens.IDENTIFIER || type == KtTokens.FIELD_IDENTIFIER) return TokenKind.IDENTIFIER;
        if (KtTokens.KEYWORDS.contains(type) || KtTokens.SOFT_KEYWORDS.contains(type)) return TokenKind.KEYWORD;
        if (KtTokens.OPERATIONS.contains(type)) return TokenKind.OPERATOR;
        return null;
    }

    private static List<NodeFlag> nodeFlags(PsiElement element) {
        List<NodeFlag> flags = new ArrayList<>();
        if (element instanceof KtClass klass && klass.isData()) flags.add(NodeFlag.DATA);
        if (element instanceof KtClass klass && klass.isSealed()) flags.add(NodeFlag.SEALED);
        if (element instanceof KtModifierListOwner owner && owner.hasModifier(KtTokens.CONST_KEYWORD)) flags.add(NodeFlag.CONST);
        if (element instanceof KtProperty property) flags.add(property.isVar() ? NodeFlag.VAR : NodeFlag.VAL);
        else if (element instanceof KtParameter parameter && parameter.hasValOrVar()) flags.add(parameter.isMutable() ? NodeFlag.VAR : NodeFlag.VAL);
        if (element instanceof KtModifierListOwner owner && owner.hasModifier(KtTokens.SUSPEND_KEYWORD)) flags.add(NodeFlag.SUSPEND);
        if (element instanceof KtModifierListOwner owner && owner.hasModifier(KtTokens.OVERRIDE_KEYWORD)) flags.add(NodeFlag.OVERRIDE);
        if (element instanceof KtModifierListOwner owner && owner.hasModifier(KtTokens.PRIVATE_KEYWORD)) flags.add(NodeFlag.PRIVATE);
        if (element instanceof KtNamedFunction function && function.hasBody() && !function.hasBlockBody()) flags.add(NodeFlag.EXPRESSION_BODY);
        if (element instanceof KtValueArgument argument && argument.isNamed()) flags.add(NodeFlag.NAMED);
        if (element instanceof KtSafeQualifiedExpression) flags.add(NodeFlag.SAFE);
        if (element instanceof KtExpressionWithLabel labeled && labeled.getLabelName() != null) flags.add(NodeFlag.LABELED);
        else if (element.getParent() instanceof KtLabeledExpression) flags.add(NodeFlag.LABELED);
        return flags;
    }

    private static String nodeName(PsiElement element) {
        if (element instanceof KtNamedDeclaration named) return named.getName();
        if (element instanceof KtSuperTypeCallEntry call) return terminalTypeName(call.getTypeReference());
        if (element instanceof KtTypeReference type) return terminalTypeName(type);
        if (element instanceof KtCallExpression call) return expressionName(call.getCalleeExpression());
        if (element instanceof KtValueArgument argument && argument.getArgumentName() != null) return argument.getArgumentName().getAsName().asString();
        if (element instanceof KtNameReferenceExpression reference) return reference.getReferencedName();
        if (element instanceof KtCallableReferenceExpression reference) return reference.getCallableReference().getReferencedName();
        if (element instanceof KtExpressionWithLabel labeled) return labeled.getLabelName();
        return null;
    }

    private static String nodeValue(PsiElement element) {
        if (element instanceof KtSuperTypeCallEntry call) {
            return terminalTypeName(call.getTypeReference()) != null
                    && call.getValueArguments().isEmpty() && call.getLambdaArguments().isEmpty()
                ? "zero_arg_super_call" : null;
        }
        if (element instanceof KtTypeProjection projection && projection.getTypeReference() == null) return "star_projection";
        if (element instanceof KtTypeReference type) return simpleTypeAtom(type);
        if (element instanceof KtBinaryExpression binary) return binary.getOperationReference().getText();
        if (element instanceof KtBinaryExpressionWithTypeRHS binary) return binary.getOperationReference().getText();
        if (element instanceof KtUnaryExpression unary) return unary.getOperationReference().getText();
        if (element instanceof KtStringTemplateExpression) return "string_template";
        if (element instanceof KtConstantExpression) return element.getText();
        if (element instanceof KtAnnotationEntry annotation && annotation.getShortName() != null) return annotation.getShortName().asString();
        return null;
    }

    private static String simpleTypeAtom(KtTypeReference reference) {
        if (reference.hasParentheses() || !reference.getAnnotationEntries().isEmpty()
                || !(reference.getTypeElement() instanceof KtUserType user)
                || user.getQualifier() != null || !user.getTypeArguments().isEmpty()) return null;
        return user.getReferencedName();
    }

    private static String expressionName(KtExpression expression) {
        if (expression instanceof KtNameReferenceExpression name) return name.getReferencedName();
        if (expression instanceof KtConstructorCalleeExpression constructor
                && constructor.getConstructorReferenceExpression() != null) {
            return constructor.getConstructorReferenceExpression().getReferencedName();
        }
        return null;
    }

    private static String terminalTypeName(KtTypeReference reference) {
        KtTypeElement element = reference.getTypeElement();
        while (element instanceof KtNullableType nullable) element = nullable.getInnerType();
        if (element instanceof KtUserType user) return user.getReferencedName();
        return null;
    }

    private static WitnessKind witnessKind(PsiElement element) {
        if (isImportedReference(element)) return WitnessKind.TYPE_REFERENCE;
        if (insideImportPackageOrTypeName(element)) return element instanceof KtTypeReference ? WitnessKind.TYPE_REFERENCE : null;
        if (element instanceof KtSuperTypeCallEntry) return WitnessKind.TYPE_REFERENCE;
        if (element instanceof KtTypeProjection projection && projection.getTypeReference() == null) return WitnessKind.TYPE_REFERENCE;
        if (isCondition(element)) return WitnessKind.CONDITION;
        if (element instanceof KtClassOrObject || element instanceof KtNamedFunction
                || element instanceof KtProperty || element instanceof KtParameter) return WitnessKind.DECLARATION;
        if (element instanceof KtCallableReferenceExpression) return WitnessKind.CALLABLE_REFERENCE;
        if (element instanceof KtCallExpression) return WitnessKind.CALL;
        if (element instanceof KtValueArgument) return WitnessKind.ARGUMENT;
        if (element instanceof KtNameReferenceExpression) return WitnessKind.PROPERTY_READ;
        if (element instanceof KtBinaryExpression binary && KtTokens.ALL_ASSIGNMENTS.contains(binary.getOperationToken())) return WitnessKind.ASSIGNMENT;
        if (element instanceof KtForExpression || element instanceof KtWhileExpressionBase) return WitnessKind.LOOP;
        if (element instanceof KtLambdaExpression) return WitnessKind.LAMBDA;
        if (element instanceof KtReturnExpression) return WitnessKind.RETURN;
        if (element instanceof KtTypeReference || element instanceof KtClassLiteralExpression) return WitnessKind.TYPE_REFERENCE;
        if (element instanceof KtCatchClause) return WitnessKind.CATCH;
        return null;
    }

    private static boolean isImportedReference(PsiElement element) {
        PsiElement current = element.getParent();
        while (current != null && !(current instanceof KtFile)) {
            if (current instanceof KtImportDirective directive) return directive.getImportedReference() == element;
            current = current.getParent();
        }
        return false;
    }

    private static boolean insideImportPackageOrTypeName(PsiElement element) {
        PsiElement current = element.getParent();
        while (current != null && !(current instanceof KtFile)) {
            if (current instanceof KtImportDirective || current instanceof KtPackageDirective
                    || current instanceof KtValueArgumentName) return true;
            if (current instanceof KtTypeReference) return !(element instanceof KtTypeReference);
            current = current.getParent();
        }
        return false;
    }

    private static boolean isCondition(PsiElement element) {
        PsiElement current = element;
        while (current.getParent() instanceof KtParenthesizedExpression parent) current = parent;
        PsiElement parent = current.getParent();
        if (parent instanceof KtIfExpression expression) return expression.getCondition() == current;
        if (parent instanceof KtWhileExpressionBase expression) return expression.getCondition() == current;
        if (parent instanceof KtWhenConditionWithExpression condition) return condition.getExpression() == current;
        if (parent instanceof KtWhenConditionInRange condition) return condition.getRangeExpression() == current;
        if (parent instanceof KtWhenConditionIsPattern condition) return condition.getTypeReference() == current;
        return false;
    }

    private static void addTypedEdges(int from, PsiElement element,
            IdentityHashMap<PsiElement, Integer> ids, List<Edge> edges) {
        if (element instanceof KtAnnotated annotated) addRelations(from, EdgeRole.ANNOTATION, annotated.getAnnotationEntries(), ids, edges);
        if (element instanceof KtFile file) addRelations(from, EdgeRole.FILE_MEMBER, file.getDeclarations(), ids, edges);
        if (element instanceof KtClassOrObject klass) {
            addRelations(from, EdgeRole.PARAMETER, klass.getPrimaryConstructorParameters(), ids, edges);
            int ordinal = 0;
            int argumentOrdinal = 0;
            for (KtSuperTypeListEntry entry : klass.getSuperTypeListEntries()) {
                PsiElement superType = entry instanceof KtSuperTypeCallEntry ? entry : entry.getTypeReference();
                ordinal = addRelation(from, EdgeRole.SUPER_TYPE, ordinal, superType, ids, edges);
                if (entry instanceof KtSuperTypeCallEntry call) {
                    for (org.jetbrains.kotlin.psi.ValueArgument argument : call.getValueArguments()) {
                        argumentOrdinal = addRelation(from, EdgeRole.ARGUMENT, argumentOrdinal,
                            argument.asElement(), ids, edges);
                    }
                    argumentOrdinal = addRelations(from, EdgeRole.ARGUMENT, argumentOrdinal,
                        call.getLambdaArguments(), ids, edges);
                }
            }
        }
        if (element instanceof KtSuperTypeCallEntry call) {
            addRelation(from, EdgeRole.TYPE, 0, call.getTypeReference(), ids, edges);
        }
        if (element instanceof KtNamedFunction function) {
            addRelations(from, EdgeRole.PARAMETER, function.getValueParameters(), ids, edges);
            int ordinal = 0;
            ordinal = addRelation(from, EdgeRole.TYPE, ordinal, function.getReceiverTypeReference(), ids, edges);
            addRelation(from, EdgeRole.TYPE, ordinal, function.getTypeReference(), ids, edges);
            addRelation(from, EdgeRole.BODY, 0, function.getBodyExpression(), ids, edges);
        } else if (element instanceof KtProperty property) {
            int ordinal = 0;
            ordinal = addRelation(from, EdgeRole.TYPE, ordinal, property.getReceiverTypeReference(), ids, edges);
            addRelation(from, EdgeRole.TYPE, ordinal, property.getTypeReference(), ids, edges);
            addRelation(from, EdgeRole.INITIALIZER, 0, property.getInitializer(), ids, edges);
        } else if (element instanceof KtParameter parameter) {
            addRelation(from, EdgeRole.TYPE, 0, parameter.getTypeReference(), ids, edges);
            addRelation(from, EdgeRole.DEFAULT_VALUE, 0, parameter.getDefaultValue(), ids, edges);
        }
        if (element instanceof KtCallExpression call) {
            addRelation(from, EdgeRole.CALLEE, 0, call.getCalleeExpression(), ids, edges);
            int argumentOrdinal = addRelations(from, EdgeRole.ARGUMENT, 0, call.getValueArguments(), ids, edges);
            addRelations(from, EdgeRole.ARGUMENT, argumentOrdinal, call.getLambdaArguments(), ids, edges);
            int ordinal = 0;
            for (KtTypeProjection projection : call.getTypeArguments()) {
                PsiElement target = projection.getTypeReference() == null ? projection : projection.getTypeReference();
                ordinal = addRelation(from, EdgeRole.TYPE_ARGUMENT, ordinal, target, ids, edges);
            }
        } else if (element instanceof KtValueArgument argument) {
            addRelation(from, EdgeRole.VALUE, 0, argument.getArgumentExpression(), ids, edges);
        }
        if (element instanceof KtQualifiedExpression qualified) {
            addRelation(from, EdgeRole.RECEIVER, 0, qualified.getReceiverExpression(), ids, edges);
            addRelation(from, EdgeRole.SELECTOR, 0, qualified.getSelectorExpression(), ids, edges);
        }
        if (element instanceof KtDoubleColonExpression reference) {
            addRelation(from, EdgeRole.RECEIVER, 0, reference.getReceiverExpression(), ids, edges);
        }
        if (element instanceof KtLambdaExpression lambda) {
            addRelations(from, EdgeRole.PARAMETER, lambda.getValueParameters(), ids, edges);
            addRelation(from, EdgeRole.LAMBDA_BODY, 0, lambda.getBodyExpression(), ids, edges);
        }
        if (element instanceof KtBinaryExpression binary) {
            boolean assignment = KtTokens.ALL_ASSIGNMENTS.contains(binary.getOperationToken());
            addRelation(from, assignment ? EdgeRole.TARGET : EdgeRole.LEFT, 0, binary.getLeft(), ids, edges);
            addRelation(from, assignment ? EdgeRole.VALUE : EdgeRole.RIGHT, 0, binary.getRight(), ids, edges);
        } else if (element instanceof KtBinaryExpressionWithTypeRHS binary) {
            addRelation(from, EdgeRole.LEFT, 0, binary.getLeft(), ids, edges);
            addRelation(from, EdgeRole.RIGHT, 0, binary.getRight(), ids, edges);
        } else if (element instanceof KtUnaryExpression unary) {
            addRelation(from, EdgeRole.OPERAND, 0, unary.getBaseExpression(), ids, edges);
        } else if (element instanceof KtArrayAccessExpression access) {
            addRelation(from, EdgeRole.RECEIVER, 0, access.getArrayExpression(), ids, edges);
            addRelations(from, EdgeRole.INDEX, access.getIndexExpressions(), ids, edges);
        } else if (element instanceof KtIfExpression expression) {
            addRelation(from, EdgeRole.CONDITION, 0, expression.getCondition(), ids, edges);
            addRelation(from, EdgeRole.THEN_BRANCH, 0, expression.getThen(), ids, edges);
            addRelation(from, EdgeRole.ELSE_BRANCH, 0, expression.getElse(), ids, edges);
        } else if (element instanceof KtWhenExpression expression) {
            addRelation(from, EdgeRole.SUBJECT, 0, expression.getSubjectExpression(), ids, edges);
            addRelations(from, EdgeRole.ENTRY, expression.getEntries(), ids, edges);
        } else if (element instanceof KtWhenEntry entry) {
            int ordinal = 0;
            for (KtWhenCondition condition : entry.getConditions()) {
                PsiElement target = null;
                if (condition instanceof KtWhenConditionWithExpression with) target = with.getExpression();
                else if (condition instanceof KtWhenConditionIsPattern pattern) target = pattern.getTypeReference();
                else if (condition instanceof KtWhenConditionInRange range) target = range.getRangeExpression();
                ordinal = addRelation(from, EdgeRole.CONDITION, ordinal, target, ids, edges);
            }
            addRelation(from, EdgeRole.BODY, 0, entry.getExpression(), ids, edges);
        } else if (element instanceof KtTryExpression expression) {
            addRelation(from, EdgeRole.TRY_BODY, 0, expression.getTryBlock(), ids, edges);
            addRelations(from, EdgeRole.CATCH_CLAUSE, expression.getCatchClauses(), ids, edges);
        } else if (element instanceof KtCatchClause clause) {
            addRelation(from, EdgeRole.PARAMETER, 0, clause.getCatchParameter(), ids, edges);
            addRelation(from, EdgeRole.CATCH_BODY, 0, clause.getCatchBody(), ids, edges);
        } else if (element instanceof KtReturnExpression expression) {
            addRelation(from, EdgeRole.RETURN_VALUE, 0, expression.getReturnedExpression(), ids, edges);
        } else if (element instanceof KtForExpression expression) {
            addRelation(from, EdgeRole.PARAMETER, 0, expression.getLoopParameter(), ids, edges);
            addRelation(from, EdgeRole.RANGE, 0, expression.getLoopRange(), ids, edges);
            addRelation(from, EdgeRole.LOOP_BODY, 0, expression.getBody(), ids, edges);
        } else if (element instanceof KtWhileExpressionBase expression) {
            addRelation(from, EdgeRole.CONDITION, 0, expression.getCondition(), ids, edges);
            addRelation(from, EdgeRole.LOOP_BODY, 0, expression.getBody(), ids, edges);
        } else if (element instanceof KtAnnotationEntry annotation) {
            addRelation(from, EdgeRole.TYPE, 0, annotation.getTypeReference(), ids, edges);
            int ordinal = 0;
            for (org.jetbrains.kotlin.psi.ValueArgument argument : annotation.getValueArguments()) {
                ordinal = addRelation(from, EdgeRole.ARGUMENT, ordinal, argument.asElement(), ids, edges);
            }
        } else if (element instanceof KtStringTemplateExpression template) {
            int ordinal = 0;
            for (KtStringTemplateEntry entry : template.getEntries()) {
                ordinal = addRelation(from, EdgeRole.STRING_EXPRESSION, ordinal, entry.getExpression(), ids, edges);
            }
        }
    }

    private static int addRelations(int from, EdgeRole role, List<? extends PsiElement> targets,
            IdentityHashMap<PsiElement, Integer> ids, List<Edge> edges) {
        return addRelations(from, role, 0, targets, ids, edges);
    }

    private static int addRelations(int from, EdgeRole role, int ordinal, List<? extends PsiElement> targets,
            IdentityHashMap<PsiElement, Integer> ids, List<Edge> edges) {
        for (PsiElement target : targets) ordinal = addRelation(from, role, ordinal, target, ids, edges);
        return ordinal;
    }

    private static int addRelation(int from, EdgeRole role, int ordinal, PsiElement rawTarget,
            IdentityHashMap<PsiElement, Integer> ids, List<Edge> edges) {
        PsiElement target = rawTarget;
        while (target instanceof KtParenthesizedExpression parenthesized) target = parenthesized.getExpression();
        if (target == null) return ordinal;
        Integer to = ids.get(target);
        if (to != null) {
            edges.add(new Edge(from, role, ordinal, to));
            return ordinal + 1;
        }
        return ordinal;
    }

    private static TextRange checkedRange(PsiElement element, String content) {
        TextRange range = element.getTextRange();
        if (range == null || range.getStartOffset() < 0 || range.getEndOffset() < range.getStartOffset()
                || range.getEndOffset() > content.length() || splitsSurrogate(content, range.getStartOffset())
                || splitsSurrogate(content, range.getEndOffset())) throw new IllegalArgumentException("invalid PSI UTF-16 range");
        return range;
    }

    private static boolean splitsSurrogate(String text, int offset) {
        return offset > 0 && offset < text.length() && Character.isHighSurrogate(text.charAt(offset - 1))
            && Character.isLowSurrogate(text.charAt(offset));
    }

    private static int lowerBoundToken(List<Token> tokens, int fileId, int start) {
        int low = 0;
        int high = tokens.size();
        while (low < high) {
            int middle = (low + high) >>> 1;
            Token token = tokens.get(middle);
            if (token.fileId() < fileId || (token.fileId() == fileId && token.startUtf16() < start)) low = middle + 1;
            else high = middle;
        }
        return low;
    }

    private static int compareEdges(Edge left, Edge right) {
        int order = Integer.compare(left.fromNodeId(), right.fromNodeId());
        if (order == 0) order = Integer.compare(left.role().ordinal(), right.role().ordinal());
        if (order == 0) order = Integer.compare(left.ordinal(), right.ordinal());
        if (order == 0) order = Integer.compare(left.toNodeId(), right.toNodeId());
        return order;
    }

    private static String witnessKindName(WitnessKind kind) {
        if (kind == WitnessKind.DECLARATION) return "declaration";
        if (kind == WitnessKind.CALLABLE_REFERENCE) return "callable_reference";
        if (kind == WitnessKind.CALL) return "call";
        if (kind == WitnessKind.ARGUMENT) return "argument";
        if (kind == WitnessKind.PROPERTY_READ) return "property_read";
        if (kind == WitnessKind.ASSIGNMENT) return "assignment";
        if (kind == WitnessKind.CONDITION) return "condition";
        if (kind == WitnessKind.LOOP) return "loop";
        if (kind == WitnessKind.LAMBDA) return "lambda";
        if (kind == WitnessKind.RETURN) return "return";
        if (kind == WitnessKind.TYPE_REFERENCE) return "type_reference";
        if (kind == WitnessKind.CATCH) return "catch";
        throw new IllegalArgumentException("unknown witness kind");
    }

    private static void validateProgram(int psiNodeCount, int declarationCount, int callSiteCount,
            List<FileUnit> files, List<ImportEntry> imports, List<Token> tokens, List<Node> nodes,
            List<Edge> edges, List<WitnessNode> witnesses) {
        if (psiNodeCount < 0 || psiNodeCount > Main.MAX_PSI_NODES || declarationCount < 0
                || declarationCount > Main.MAX_DECLARATIONS || callSiteCount < 0
                || callSiteCount > Main.MAX_CALL_SITES) throw new IllegalArgumentException("program count is invalid");
        if (psiNodeCount < nodes.size() || psiNodeCount < tokens.size() || psiNodeCount < witnesses.size()) {
            throw new IllegalArgumentException("program catalogs exceed the PSI count");
        }
        String priorPath = null;
        for (int index = 0; index < files.size(); index++) {
            FileUnit file = files.get(index);
            if (file.id() != index || (priorPath != null && Protocol.compareUtf8(priorPath, file.path()) >= 0)) {
                throw new IllegalArgumentException("file table is not canonical");
            }
            priorPath = file.path();
        }
        int expectedImport = 0;
        for (FileUnit file : files) {
            for (int importId : file.importIds()) {
                if (importId != expectedImport++ || importId >= imports.size()
                        || imports.get(importId).fileId() != file.id()) {
                    throw new IllegalArgumentException("file import closure is invalid");
                }
            }
        }
        if (expectedImport != imports.size()) throw new IllegalArgumentException("orphan import");
        for (int index = 0; index < imports.size(); index++) {
            ImportEntry entry = imports.get(index);
            if (entry.id() != index || entry.fileId() >= files.size() || entry.syntaxNodeId() >= nodes.size()) {
                throw new IllegalArgumentException("import table is invalid");
            }
        }
        int priorFile = -1;
        int priorStart = -1;
        int priorEnd = -1;
        for (int index = 0; index < tokens.size(); index++) {
            Token token = tokens.get(index);
            if (token.id() != index || token.fileId() >= files.size()
                    || token.endUtf16() > files.get(token.fileId()).utf16Length()
                    || token.fileId() < priorFile || (token.fileId() == priorFile
                    && (token.startUtf16() <= priorStart || token.startUtf16() < priorEnd))
                    || token.endUtf16() - token.startUtf16() != token.value().length()
                    || token.structuralToken() != tokenStructural(token.kind())
                    || !Protocol.sha256(token.value().getBytes(StandardCharsets.UTF_8)).equals(token.textSha256())) {
                throw new IllegalArgumentException("token table is not canonical");
            }
            if (token.fileId() != priorFile) priorEnd = -1;
            priorFile = token.fileId();
            priorStart = token.startUtf16();
            priorEnd = token.endUtf16();
        }
        int[] lexicalInbound = new int[nodes.size()];
        int[] fileRoots = new int[files.size()];
        int priorNodeFile = -1;
        int priorNodeStart = -1;
        int representedDeclarations = 0;
        int representedCalls = 0;
        Set<String> nodeIdentities = new HashSet<>();
        for (int index = 0; index < nodes.size(); index++) {
            Node node = nodes.get(index);
            String identity = node.fileId() + ":" + node.startUtf16() + ":" + node.endUtf16()
                + ":" + node.kind().ordinal();
            if (node.id() != index || node.fileId() >= files.size()
                    || node.endUtf16() > files.get(node.fileId()).utf16Length()
                    || node.firstTokenId() + node.tokenCount() > tokens.size() || node.fileId() < priorNodeFile
                    || (node.fileId() == priorNodeFile && node.startUtf16() < priorNodeStart)
                    || !nodeIdentities.add(identity)) throw new IllegalArgumentException("node table is invalid");
            int expectedFirstToken = lowerBoundToken(tokens, node.fileId(), node.startUtf16());
            int expectedTokenCount = 0;
            for (int tokenId = expectedFirstToken; tokenId < tokens.size(); tokenId++) {
                Token token = tokens.get(tokenId);
                if (token.fileId() != node.fileId() || token.startUtf16() >= node.endUtf16()) break;
                expectedTokenCount++;
            }
            if (node.firstTokenId() != expectedFirstToken || node.tokenCount() != expectedTokenCount) {
                throw new IllegalArgumentException("node token slice is incomplete");
            }
            priorNodeFile = node.fileId();
            priorNodeStart = node.startUtf16();
            if (node.kind() == NodeKind.CALL) representedCalls++;
            if (node.name() != null && isDeclarationKind(node.kind())) representedDeclarations++;
            if (node.kind() == NodeKind.FILE && (node.startUtf16() != 0
                    || node.endUtf16() != files.get(node.fileId()).utf16Length()
                    || ++fileRoots[node.fileId()] != 1)) throw new IllegalArgumentException("file root is invalid");
            for (int tokenId = node.firstTokenId(); tokenId < node.firstTokenId() + node.tokenCount(); tokenId++) {
                Token token = tokens.get(tokenId);
                if (token.fileId() != node.fileId() || token.startUtf16() < node.startUtf16()
                        || token.endUtf16() > node.endUtf16()) throw new IllegalArgumentException("node token closure is invalid");
            }
        }
        if (representedCalls != callSiteCount || representedDeclarations > declarationCount) {
            throw new IllegalArgumentException("program counters do not cover the normalized catalogs");
        }
        for (int roots : fileRoots) if (roots != 1) throw new IllegalArgumentException("file root closure is invalid");
        Set<Integer> importSyntaxNodes = new HashSet<>();
        for (ImportEntry entry : imports) {
            if (nodes.get(entry.syntaxNodeId()).fileId() != entry.fileId()) {
                throw new IllegalArgumentException("import syntax node crosses files");
            }
            if (!importSyntaxNodes.add(entry.syntaxNodeId())) throw new IllegalArgumentException("duplicate import syntax node");
        }
        Edge priorEdge = null;
        Map<String, Integer> nextOrdinals = new HashMap<>();
        Set<Integer> conditionTargets = new HashSet<>();
        for (Edge edge : edges) {
            if (edge.fromNodeId() >= nodes.size() || edge.toNodeId() >= nodes.size()
                    || edge.fromNodeId() >= edge.toNodeId()
                    || (priorEdge != null && compareEdges(priorEdge, edge) >= 0)) {
                throw new IllegalArgumentException("edge table is not canonical");
            }
            Node from = nodes.get(edge.fromNodeId());
            Node to = nodes.get(edge.toNodeId());
            if (from.fileId() != to.fileId() || from.startUtf16() > to.startUtf16()
                    || from.endUtf16() < to.endUtf16()) throw new IllegalArgumentException("edge span closure is invalid");
            String slot = edge.fromNodeId() + ":" + edge.role().ordinal();
            int expectedOrdinal = nextOrdinals.getOrDefault(slot, 0);
            if (edge.ordinal() != expectedOrdinal) throw new IllegalArgumentException("edge ordinals are not dense");
            nextOrdinals.put(slot, expectedOrdinal + 1);
            if (edge.role() == EdgeRole.LEXICAL_OWNER) lexicalInbound[edge.toNodeId()]++;
            if (edge.role() == EdgeRole.CONDITION) conditionTargets.add(edge.toNodeId());
            priorEdge = edge;
        }
        for (int index = 0; index < nodes.size(); index++) {
            int expected = nodes.get(index).kind() == NodeKind.FILE ? 0 : 1;
            if (lexicalInbound[index] != expected) throw new IllegalArgumentException("lexical owner closure is invalid");
        }
        String priorWitness = null;
        Set<String> witnessIds = new HashSet<>();
        Map<String, WitnessNode> witnessesById = new HashMap<>();
        for (WitnessNode witness : witnesses) {
            if (witness.fileId() >= files.size()) throw new IllegalArgumentException("witness file is invalid");
            FileUnit file = files.get(witness.fileId());
            Map<String, Object> identity = Map.of(
                "path", file.path(), "fileSha256", file.sha256(),
                "startUtf16", witness.startUtf16(), "endUtf16", witness.endUtf16(),
                "kind", witnessKindName(witness.kind()), "textSha256", witness.textSha256(),
                "structuralToken", witness.structuralToken());
            if (witness.endUtf16() > file.utf16Length()
                    || (priorWitness != null && Protocol.compareUtf8(priorWitness, witness.nodeId()) >= 0)
                    || !Protocol.sha256(Protocol.canonicalBytes(identity)).equals(witness.nodeId())
                    || !witnessIds.add(witness.nodeId())) throw new IllegalArgumentException("witness table is not canonical");
            witnessesById.put(witness.nodeId(), witness);
            priorWitness = witness.nodeId();
        }
        Set<String> nodeWitnesses = new HashSet<>();
        for (Node node : nodes) {
            if (node.witnessNodeId() == null) continue;
            WitnessNode witness = witnessesById.get(node.witnessNodeId());
            boolean structural = false;
            for (int tokenId = node.firstTokenId(); tokenId < node.firstTokenId() + node.tokenCount(); tokenId++) {
                structural |= tokens.get(tokenId).structuralToken();
            }
            if (witness == null || !nodeWitnesses.add(node.witnessNodeId()) || witness.fileId() != node.fileId()
                    || witness.startUtf16() != node.startUtf16() || witness.endUtf16() != node.endUtf16()
                    || witness.structuralToken() != structural
                    || !compatibleWitnessKind(node, witness.kind(), conditionTargets.contains(node.id()),
                        importSyntaxNodes.contains(node.id()))) {
                throw new IllegalArgumentException("node witness closure is invalid");
            }
        }
        if (!nodeWitnesses.equals(witnessIds)) throw new IllegalArgumentException("orphan witness node");
        for (ImportEntry entry : imports) {
            if (entry.witnessNodeId() == null
                    || !entry.witnessNodeId().equals(nodes.get(entry.syntaxNodeId()).witnessNodeId())) {
                throw new IllegalArgumentException("import witness closure is invalid");
            }
        }
    }

    private static boolean compatibleWitnessKind(Node node, WitnessKind kind, boolean conditionTarget,
            boolean importSyntaxNode) {
        if (kind == WitnessKind.CONDITION) return conditionTarget;
        if (conditionTarget) return false;
        if (importSyntaxNode) return kind == WitnessKind.TYPE_REFERENCE;
        NodeKind nodeKind = node.kind();
        if (kind == WitnessKind.DECLARATION) return nodeKind == NodeKind.CLASS_DECL
            || nodeKind == NodeKind.INTERFACE_DECL || nodeKind == NodeKind.OBJECT_DECL
            || nodeKind == NodeKind.COMPANION_DECL || nodeKind == NodeKind.FUNCTION_DECL
            || nodeKind == NodeKind.PROPERTY_DECL || nodeKind == NodeKind.PARAMETER_DECL;
        if (kind == WitnessKind.CALLABLE_REFERENCE) return nodeKind == NodeKind.CALLABLE_REF;
        if (kind == WitnessKind.CALL) return nodeKind == NodeKind.CALL;
        if (kind == WitnessKind.ARGUMENT) return nodeKind == NodeKind.ARGUMENT;
        if (kind == WitnessKind.PROPERTY_READ) return nodeKind == NodeKind.NAME_REF;
        if (kind == WitnessKind.ASSIGNMENT) return nodeKind == NodeKind.ASSIGNMENT;
        if (kind == WitnessKind.LOOP) return nodeKind == NodeKind.FOR || nodeKind == NodeKind.WHILE;
        if (kind == WitnessKind.LAMBDA) return nodeKind == NodeKind.LAMBDA;
        if (kind == WitnessKind.RETURN) return nodeKind == NodeKind.RETURN;
        if (kind == WitnessKind.TYPE_REFERENCE) return nodeKind == NodeKind.TYPE_REF || nodeKind == NodeKind.CLASS_LITERAL;
        if (kind == WitnessKind.CATCH) return nodeKind == NodeKind.CATCH;
        return false;
    }

    private static boolean tokenStructural(TokenKind kind) {
        return kind == TokenKind.IDENTIFIER || kind == TokenKind.KEYWORD || kind == TokenKind.OPERATOR;
    }

    private static boolean isDeclarationKind(NodeKind kind) {
        return kind == NodeKind.CLASS_DECL || kind == NodeKind.INTERFACE_DECL
            || kind == NodeKind.OBJECT_DECL || kind == NodeKind.COMPANION_DECL
            || kind == NodeKind.FUNCTION_DECL || kind == NodeKind.PROPERTY_DECL
            || kind == NodeKind.PARAMETER_DECL;
    }

    private static boolean isSnapshotRejection(String code) {
        return "parse".equals(code) || "ambiguous_index".equals(code)
            || "incomplete_imports".equals(code) || "limit".equals(code);
    }

    private static boolean isKnownRejection(String code) {
        return isSnapshotRejection(code) || "unsupported_script".equals(code) || "internal_uncertainty".equals(code);
    }

    private static boolean isHash(String value) {
        if (value == null || value.length() != 64) return false;
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            if (!((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f'))) return false;
        }
        return true;
    }

    private static void requireText(String value, String label) {
        if (value == null || value.isEmpty()) throw new IllegalArgumentException(label + " is empty");
    }
}
