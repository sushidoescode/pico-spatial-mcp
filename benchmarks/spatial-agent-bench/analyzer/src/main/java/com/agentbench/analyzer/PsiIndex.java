package com.agentbench.analyzer;

import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.jetbrains.kotlin.cli.common.CLIConfigurationKeys;
import org.jetbrains.kotlin.cli.common.messages.MessageCollector;
import org.jetbrains.kotlin.cli.jvm.compiler.EnvironmentConfigFiles;
import org.jetbrains.kotlin.cli.jvm.compiler.KotlinCoreEnvironment;
import org.jetbrains.kotlin.com.intellij.openapi.Disposable;
import org.jetbrains.kotlin.com.intellij.openapi.util.Disposer;
import org.jetbrains.kotlin.com.intellij.psi.PsiElement;
import org.jetbrains.kotlin.com.intellij.psi.util.PsiTreeUtil;
import org.jetbrains.kotlin.config.CommonConfigurationKeys;
import org.jetbrains.kotlin.config.CompilerConfiguration;
import org.jetbrains.kotlin.psi.KtCallExpression;
import org.jetbrains.kotlin.psi.KtFile;
import org.jetbrains.kotlin.psi.KtImportDirective;
import org.jetbrains.kotlin.psi.KtNamedDeclaration;
import org.jetbrains.kotlin.psi.KtPsiFactory;
import org.jetbrains.kotlin.resolve.ImportPath;

final class PsiIndex {
    record Source(String path, String content) {}
    record Result(String rejectionCode) {
        static Result accepted() { return new Result(null); }
        static Result rejected(String code) { return new Result(code); }
    }

    private PsiIndex() {}

    static Result analyze(List<Source> sources) {
        Disposable disposable = Disposer.newDisposable("agentbench-kotlin-psi-v1");
        try {
            CompilerConfiguration configuration = new CompilerConfiguration();
            configuration.put(CLIConfigurationKeys.MESSAGE_COLLECTOR_KEY, MessageCollector.Companion.getNONE());
            configuration.put(CommonConfigurationKeys.MODULE_NAME, "agentbench-analyzer-v1");
            KotlinCoreEnvironment environment = KotlinCoreEnvironment.createForProduction(
                disposable, configuration, EnvironmentConfigFiles.JVM_CONFIG_FILES);
            KtPsiFactory factory = new KtPsiFactory(environment.getProject(), false);
            Map<String, String> declarations = new HashMap<>();
            int psiNodes = 0;
            int declarationCount = 0;
            int callSites = 0;

            for (Source source : sources) {
                KtFile file = factory.createFile(source.path(), source.content());
                if (PsiTreeUtil.hasErrorElements(file)) return Result.rejected("parse");
                if (file.getPackageFqName().asString().isEmpty()) return Result.rejected("incomplete_imports");
                if (!importsComplete(file)) return Result.rejected("incomplete_imports");

                ArrayDeque<PsiElement> pending = new ArrayDeque<>();
                pending.push(file);
                while (!pending.isEmpty()) {
                    PsiElement element = pending.pop();
                    if (++psiNodes > Main.MAX_PSI_NODES) return Result.rejected("limit");
                    if (element instanceof KtCallExpression && ++callSites > Main.MAX_CALL_SITES) {
                        return Result.rejected("limit");
                    }
                    if (element instanceof KtNamedDeclaration named && named.getName() != null) {
                        if (++declarationCount > Main.MAX_DECLARATIONS) return Result.rejected("limit");
                        String key = declarationKey(file, named);
                        String prior = declarations.putIfAbsent(key, source.path());
                        if (prior != null) return Result.rejected("ambiguous_index");
                    }
                    PsiElement[] children = element.getChildren();
                    for (int index = children.length - 1; index >= 0; index--) pending.push(children[index]);
                }
            }
            return Result.accepted();
        } catch (Throwable uncertainty) {
            return Result.rejected("internal_uncertainty");
        } finally {
            Disposer.dispose(disposable);
        }
    }

    private static boolean importsComplete(KtFile file) {
        Map<String, String> exposed = new HashMap<>();
        for (KtImportDirective directive : file.getImportDirectives()) {
            ImportPath imported = directive.getImportPath();
            if (imported == null || !directive.isValidImport() || imported.isAllUnder()) return false;
            String fqName = imported.getFqName().asString();
            String name = imported.hasAlias() ? imported.getAlias().asString() : imported.getImportedName().asString();
            String prior = exposed.putIfAbsent(name, fqName);
            if (prior != null && !prior.equals(fqName)) return false;
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
}
