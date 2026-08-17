package com.agentbench.analyzer;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

final class AbstractInterpreter {
    private final PsiIndex.Program program;
    private final Rules.Domain domain;
    private final Map<Integer, List<PsiIndex.Edge>> outgoing;
    private final Map<Integer, Integer> lexicalOwners;

    AbstractInterpreter(PsiIndex.Program program, Rules.Domain domain) {
        if (program == null || domain == null) throw new IllegalArgumentException("interpreter input is null");
        this.program = program;
        this.domain = domain;
        Map<Integer, List<PsiIndex.Edge>> mutableOutgoing = new HashMap<>();
        Map<Integer, Integer> mutableOwners = new HashMap<>();
        for (PsiIndex.Edge edge : program.edges()) {
            mutableOutgoing.computeIfAbsent(edge.fromNodeId(), ignored -> new ArrayList<>()).add(edge);
            if (edge.role() == PsiIndex.EdgeRole.LEXICAL_OWNER
                    && mutableOwners.put(edge.toNodeId(), edge.fromNodeId()) != null) {
                throw new IllegalArgumentException("duplicate lexical owner");
            }
        }
        Map<Integer, List<PsiIndex.Edge>> frozen = new HashMap<>();
        for (Map.Entry<Integer, List<PsiIndex.Edge>> entry : mutableOutgoing.entrySet()) {
            frozen.put(entry.getKey(), List.copyOf(entry.getValue()));
        }
        this.outgoing = Map.copyOf(frozen);
        this.lexicalOwners = Map.copyOf(mutableOwners);
    }

    Rules.Analysis analyze() {
        if (hasUnmodeledNamedDeclarations()) return Rules.emptyAnalysis();
        Rules.SymbolSpec cloneSymbol = uniqueCloneSymbol();
        Rules.SymbolSpec componentType = relatedType(cloneSymbol);
        Rules.SymbolSpec componentConstructor = relatedConstructor(componentType, cloneSymbol);
        domain.symbol(componentType.fqn(), componentType.signature());
        domain.symbol(componentConstructor.fqn(), componentConstructor.signature());
        domain.symbol(cloneSymbol.fqn(), cloneSymbol.signature());
        String cloneName = domainMemberName(componentType, cloneSymbol);
        Rules.RuleSpec cloneRule = relatedRule(cloneName);
        Rules.Analysis match = null;
        for (PsiIndex.Node node : program.nodes()) {
            if (node.kind() != PsiIndex.NodeKind.CLASS_DECL) continue;
            Rules.Analysis candidate = analyzeClass(node, componentType.fqn(), cloneName, cloneRule);
            if (candidate == null) continue;
            if (match != null) return Rules.emptyAnalysis();
            match = candidate;
        }
        return match == null ? Rules.emptyAnalysis() : match;
    }

    private Rules.Analysis analyzeClass(PsiIndex.Node klass, String componentFqn, String cloneName,
            Rules.RuleSpec cloneRule) {
        if (klass.name() == null || !isTopLevel(klass)) return null;
        List<PsiIndex.Node> superTypes = targets(klass, PsiIndex.EdgeRole.SUPER_TYPE);
        if (superTypes.size() != 1) return null;
        PsiIndex.Node componentType = superTypes.get(0);
        PsiIndex.ImportEntry componentImport = componentImport(componentType, klass, componentFqn);
        if (componentImport == null || !targets(klass, PsiIndex.EdgeRole.ARGUMENT).isEmpty()
                || hasUnsupportedClassShape(klass) || hasConstructorCompetitor(klass)) return null;

        List<PsiIndex.Node> parameters = targets(klass, PsiIndex.EdgeRole.PARAMETER);
        List<PsiIndex.Node> retained = new ArrayList<>();
        for (PsiIndex.Node parameter : parameters) {
            if (parameter.kind() != PsiIndex.NodeKind.PARAMETER_DECL || parameter.name() == null
                    || one(parameter, PsiIndex.EdgeRole.TYPE) == null
                    || one(parameter, PsiIndex.EdgeRole.DEFAULT_VALUE) == null) return null;
            if (parameter.flags().contains(PsiIndex.NodeFlag.VAL)
                    || parameter.flags().contains(PsiIndex.NodeFlag.VAR)) retained.add(parameter);
        }
        if (retained.isEmpty()) return null;

        PsiIndex.Node clone = null;
        for (PsiIndex.Node child : lexicalChildren(klass)) {
            if (child.kind() != PsiIndex.NodeKind.FUNCTION_DECL || !cloneName.equals(child.name())) continue;
            if (clone != null) return null;
            clone = child;
        }
        if (clone == null || !clone.flags().contains(PsiIndex.NodeFlag.OVERRIDE)
                || clone.flags().contains(PsiIndex.NodeFlag.SUSPEND)
                || clone.flags().contains(PsiIndex.NodeFlag.PRIVATE)
                || !targets(clone, PsiIndex.EdgeRole.PARAMETER).isEmpty()) return null;
        List<PsiIndex.Node> returnTypes = targets(clone, PsiIndex.EdgeRole.TYPE);
        if (returnTypes.size() != 1 || !klass.name().equals(returnTypes.get(0).name())
                || !klass.name().equals(returnTypes.get(0).value())) return null;

        PsiIndex.Node body = one(clone, PsiIndex.EdgeRole.BODY);
        if (body == null || hasUnsupportedCloneModifier(clone, body)
                || cloneRule.proofForms().size() != 2 || cloneRule.alternatives().size() != 2) return null;
        int proofIndex;
        PsiIndex.Node returned = null;
        PsiIndex.Node call;
        if (body.kind() == PsiIndex.NodeKind.CALL
                && clone.flags().contains(PsiIndex.NodeFlag.EXPRESSION_BODY)) {
            proofIndex = 0;
            call = body;
        } else if (body.kind() == PsiIndex.NodeKind.BLOCK
                && !clone.flags().contains(PsiIndex.NodeFlag.EXPRESSION_BODY)) {
            List<PsiIndex.Node> statements = lexicalChildren(body);
            if (statements.size() != 1 || statements.get(0).kind() != PsiIndex.NodeKind.RETURN
                    || statements.get(0).flags().contains(PsiIndex.NodeFlag.LABELED)) return null;
            returned = statements.get(0);
            call = one(returned, PsiIndex.EdgeRole.RETURN_VALUE);
            if (call == null || call.kind() != PsiIndex.NodeKind.CALL) return null;
            proofIndex = 1;
        } else return null;
        String proofForm = cloneRule.proofForms().get(proofIndex);
        Rules.AlternativeSpec alternatives = cloneRule.alternatives().get(proofIndex);
        if (!alternatives.proofForm().equals(proofForm) || alternatives.alternativeIds().size() != 2
                || !klass.name().equals(call.name())
                || !targets(call, PsiIndex.EdgeRole.TYPE_ARGUMENT).isEmpty()) return null;
        PsiIndex.Node callee = one(call, PsiIndex.EdgeRole.CALLEE);
        if (callee == null || callee.kind() != PsiIndex.NodeKind.NAME_REF
                || !klass.name().equals(callee.name())) return null;

        List<PsiIndex.Node> arguments = targets(call, PsiIndex.EdgeRole.ARGUMENT);
        if (arguments.isEmpty()) return null;
        boolean named = arguments.get(0).flags().contains(PsiIndex.NodeFlag.NAMED);
        for (PsiIndex.Node argument : arguments) {
            if (argument.kind() != PsiIndex.NodeKind.ARGUMENT
                    || argument.flags().contains(PsiIndex.NodeFlag.NAMED) != named) return null;
        }
        if (named) {
            if (!matchesNamed(arguments, retained)) return null;
        } else if (!matchesPositional(arguments, parameters, retained)) return null;
        String alternative = alternatives.alternativeIds().get(named ? 1 : 0);

        List<String> witnessIds = new ArrayList<>();
        if (!addWitness(klass, witnessIds) || !addWitness(componentType, witnessIds)
                || !addWitness(componentImport, witnessIds)) return null;
        for (PsiIndex.Node parameter : retained) {
            if (!addWitness(parameter, witnessIds)
                    || !addWitness(one(parameter, PsiIndex.EdgeRole.TYPE), witnessIds)) return null;
        }
        if (!addWitness(clone, witnessIds) || !addWitness(returnTypes.get(0), witnessIds)
                || !addWitness(call, witnessIds) || !addWitness(callee, witnessIds)) return null;
        if (returned != null && !addWitness(returned, witnessIds)) return null;
        for (PsiIndex.Node argument : arguments) {
            if (!addWitness(argument, witnessIds)
                    || !addWitness(one(argument, PsiIndex.EdgeRole.VALUE), witnessIds)) return null;
        }
        if (witnessIds.size() > Main.MAX_WITNESSES_PER_CLAIM) return null;
        return Rules.claim(program, domain, cloneRule.ruleId(), proofForm, alternative, witnessIds);
    }

    private Rules.SymbolSpec uniqueCloneSymbol() {
        Rules.SymbolSpec match = null;
        for (Rules.SymbolSpec symbol : domain.symbols()) {
            if (!symbol.kind().equals("member_function") || symbol.receiverAbstractType() == null
                    || !symbol.receiverAbstractType().equals(symbol.returnAbstractType())
                    || !symbol.memberPrecedence().equals("sdk_member_wins") || !symbol.arguments().isEmpty()
                    || !symbol.callbacks().isEmpty() || symbol.effects().isEmpty()) continue;
            Rules.SymbolSpec type = relatedTypeOrNull(symbol);
            if (type == null || relatedConstructorOrNull(type, symbol) == null) continue;
            if (match != null) throw new IllegalArgumentException("clone canary symbol is ambiguous");
            match = symbol;
        }
        if (match == null) throw new IllegalArgumentException("clone canary symbol is missing");
        return match;
    }

    private Rules.SymbolSpec relatedType(Rules.SymbolSpec member) {
        Rules.SymbolSpec type = relatedTypeOrNull(member);
        if (type == null) throw new IllegalArgumentException("clone canary type is missing");
        return type;
    }

    private Rules.SymbolSpec relatedTypeOrNull(Rules.SymbolSpec member) {
        Rules.SymbolSpec match = null;
        for (Rules.SymbolSpec symbol : domain.symbols()) {
            if (!symbol.kind().equals("type") || symbol.receiverAbstractType() != null
                    || !member.receiverAbstractType().equals(symbol.returnAbstractType())
                    || !member.fqn().startsWith(symbol.fqn() + ".") || !symbol.arguments().isEmpty()
                    || !symbol.callbacks().isEmpty() || !symbol.effects().isEmpty()) continue;
            if (match != null) throw new IllegalArgumentException("clone canary type is ambiguous");
            match = symbol;
        }
        return match;
    }

    private Rules.SymbolSpec relatedConstructor(Rules.SymbolSpec type, Rules.SymbolSpec member) {
        Rules.SymbolSpec constructor = relatedConstructorOrNull(type, member);
        if (constructor == null) throw new IllegalArgumentException("clone canary constructor is missing");
        return constructor;
    }

    private Rules.SymbolSpec relatedConstructorOrNull(Rules.SymbolSpec type, Rules.SymbolSpec member) {
        Rules.SymbolSpec match = null;
        for (Rules.SymbolSpec symbol : domain.symbols()) {
            if (!symbol.kind().equals("constructor") || !symbol.fqn().equals(type.fqn())
                    || symbol.receiverAbstractType() != null
                    || !type.returnAbstractType().equals(symbol.returnAbstractType())
                    || !symbol.arguments().equals(member.arguments()) || !symbol.callbacks().equals(member.callbacks())
                    || !symbol.effects().equals(member.effects())) continue;
            if (match != null) throw new IllegalArgumentException("clone canary constructor is ambiguous");
            match = symbol;
        }
        return match;
    }

    private String domainMemberName(Rules.SymbolSpec type, Rules.SymbolSpec member) {
        String prefix = type.fqn() + ".";
        if (!member.fqn().startsWith(prefix)) throw new IllegalArgumentException("domain member owner mismatch");
        String name = member.fqn().substring(prefix.length());
        if (name.isEmpty() || name.indexOf('.') >= 0) throw new IllegalArgumentException("domain member name is invalid");
        return name;
    }

    private Rules.RuleSpec relatedRule(String memberName) {
        Rules.RuleSpec match = null;
        String suffix = "-" + memberName;
        for (Rules.RuleSpec rule : domain.rules()) {
            if (!rule.ruleId().endsWith(suffix)) continue;
            if (match != null) throw new IllegalArgumentException("clone rule is ambiguous");
            match = rule;
        }
        if (match == null) throw new IllegalArgumentException("clone rule is missing");
        return domain.rule(match.ruleId());
    }

    private PsiIndex.ImportEntry componentImport(PsiIndex.Node type, PsiIndex.Node klass, String componentFqn) {
        if (type.kind() != PsiIndex.NodeKind.TYPE_REF || type.name() == null || type.value() == null
                || type.fileId() != klass.fileId()) return null;
        PsiIndex.Node referencedType = one(type, PsiIndex.EdgeRole.TYPE);
        if (referencedType == null || referencedType.kind() != PsiIndex.NodeKind.TYPE_REF
                || referencedType.name() == null || referencedType.value() == null) return null;
        PsiIndex.ImportEntry match = null;
        for (int importId : program.file(klass.fileId()).importIds()) {
            PsiIndex.ImportEntry entry = program.imports().get(importId);
            if (!entry.exposedName().equals(type.name()) || !type.value().equals("zero_arg_super_call")
                    || !entry.exposedName().equals(referencedType.name())
                    || !entry.exposedName().equals(referencedType.value())
                    || !entry.fqName().equals(componentFqn)) continue;
            if (match != null) return null;
            match = entry;
        }
        if (match == null) return null;
        String packageName = program.file(klass.fileId()).packageName();
        for (PsiIndex.Node declaration : program.nodes()) {
            if (!isTypeDeclaration(declaration) || !type.name().equals(declaration.name())) continue;
            if (program.file(declaration.fileId()).packageName().equals(packageName)
                    || declaration.fileId() == klass.fileId()) return null;
        }
        return match;
    }

    private boolean hasUnmodeledNamedDeclarations() {
        int represented = 0;
        for (PsiIndex.Node node : program.nodes()) {
            if (node.name() != null && isDeclarationKind(node.kind())) represented++;
            if (node.kind() == PsiIndex.NodeKind.CLASS_DECL
                    && !targets(node, PsiIndex.EdgeRole.PARAMETER).isEmpty()) represented++;
        }
        return represented != program.declarationCount();
    }

    private boolean hasUnsupportedClassShape(PsiIndex.Node klass) {
        if (klass.flags().contains(PsiIndex.NodeFlag.SEALED)) return true;
        for (PsiIndex.Node child : lexicalChildren(klass)) {
            if (child.kind() == PsiIndex.NodeKind.BLOCK
                    || child.kind() == PsiIndex.NodeKind.PROPERTY_DECL) return true;
        }
        for (int tokenId = klass.firstTokenId(); tokenId < klass.firstTokenId() + klass.tokenCount(); tokenId++) {
            PsiIndex.Token token = program.tokens().get(tokenId);
            if (token.kind() != PsiIndex.TokenKind.KEYWORD) continue;
            String value = token.value();
            if (value.equals("abstract") || value.equals("annotation") || value.equals("constructor")
                    || value.equals("context")
                    || value.equals("enum") || value.equals("expect") || value.equals("init") || value.equals("sealed")
                    || value.equals("value")) return true;
        }
        return false;
    }

    private boolean hasUnsupportedCloneModifier(PsiIndex.Node clone, PsiIndex.Node body) {
        for (int tokenId = clone.firstTokenId(); tokenId < clone.firstTokenId() + clone.tokenCount(); tokenId++) {
            PsiIndex.Token token = program.tokens().get(tokenId);
            if (token.startUtf16() >= body.startUtf16()) break;
            if (token.kind() != PsiIndex.TokenKind.KEYWORD) continue;
            String value = token.value();
            if (value.equals("abstract") || value.equals("context") || value.equals("external")
                    || value.equals("infix") || value.equals("inline") || value.equals("internal")
                    || value.equals("operator") || value.equals("private") || value.equals("protected")
                    || value.equals("suspend") || value.equals("tailrec")) return true;
        }
        return false;
    }

    private boolean isDirectNameValue(PsiIndex.Node argument, PsiIndex.Node value, boolean named) {
        if (value.tokenCount() != 1) return false;
        PsiIndex.Token token = program.tokens().get(value.firstTokenId());
        if (token.kind() != PsiIndex.TokenKind.IDENTIFIER || !value.name().equals(token.value())) return false;
        if (argument.endUtf16() != value.endUtf16()) return false;
        if (!named) return argument.startUtf16() == value.startUtf16();
        if (argument.tokenCount() != 3 || argument.firstTokenId() + 2 != value.firstTokenId()) return false;
        PsiIndex.Token label = program.tokens().get(argument.firstTokenId());
        PsiIndex.Token equals = program.tokens().get(argument.firstTokenId() + 1);
        return label.kind() == PsiIndex.TokenKind.IDENTIFIER && label.value().equals(argument.name())
            && equals.kind() == PsiIndex.TokenKind.OPERATOR && equals.value().equals("=");
    }

    private boolean hasConstructorCompetitor(PsiIndex.Node klass) {
        for (int importId : program.file(klass.fileId()).importIds()) {
            if (program.imports().get(importId).exposedName().equals(klass.name())) return true;
        }
        String packageName = program.file(klass.fileId()).packageName();
        for (PsiIndex.Node declaration : program.nodes()) {
            if (declaration.id() == klass.id() || !klass.name().equals(declaration.name())
                    || !isCallableDeclaration(declaration)) continue;
            if (isWithin(declaration, klass)) return true;
            if (isTopLevel(declaration)
                    && program.file(declaration.fileId()).packageName().equals(packageName)) return true;
        }
        return false;
    }

    private boolean matchesNamed(List<PsiIndex.Node> arguments, List<PsiIndex.Node> retained) {
        if (arguments.size() != retained.size()) return false;
        Map<String, PsiIndex.Node> fields = new HashMap<>();
        for (PsiIndex.Node parameter : retained) if (fields.put(parameter.name(), parameter) != null) return false;
        for (PsiIndex.Node argument : arguments) {
            PsiIndex.Node field = fields.remove(argument.name());
            PsiIndex.Node value = one(argument, PsiIndex.EdgeRole.VALUE);
            if (field == null || value == null || value.kind() != PsiIndex.NodeKind.NAME_REF
                    || !field.name().equals(value.name()) || !isDirectNameValue(argument, value, true)) return false;
        }
        return fields.isEmpty();
    }

    private boolean matchesPositional(List<PsiIndex.Node> arguments, List<PsiIndex.Node> parameters,
            List<PsiIndex.Node> retained) {
        if (parameters.size() != retained.size() || arguments.size() != parameters.size()) return false;
        for (int index = 0; index < arguments.size(); index++) {
            PsiIndex.Node value = one(arguments.get(index), PsiIndex.EdgeRole.VALUE);
            if (value == null || value.kind() != PsiIndex.NodeKind.NAME_REF
                    || !parameters.get(index).name().equals(value.name())
                    || !isDirectNameValue(arguments.get(index), value, false)) return false;
        }
        return true;
    }

    private List<PsiIndex.Node> lexicalChildren(PsiIndex.Node owner) {
        return targets(owner, PsiIndex.EdgeRole.LEXICAL_OWNER);
    }

    private List<PsiIndex.Node> targets(PsiIndex.Node from, PsiIndex.EdgeRole role) {
        List<PsiIndex.Node> result = new ArrayList<>();
        for (PsiIndex.Edge edge : outgoing.getOrDefault(from.id(), List.of())) {
            if (edge.role() == role) result.add(program.node(edge.toNodeId()));
        }
        return result;
    }

    private PsiIndex.Node one(PsiIndex.Node from, PsiIndex.EdgeRole role) {
        List<PsiIndex.Node> values = targets(from, role);
        return values.size() == 1 ? values.get(0) : null;
    }

    private boolean addWitness(PsiIndex.Node node, List<String> witnessIds) {
        if (node == null || node.witnessNodeId() == null) return false;
        witnessIds.add(node.witnessNodeId());
        return true;
    }

    private boolean addWitness(PsiIndex.ImportEntry entry, List<String> witnessIds) {
        if (entry == null || entry.witnessNodeId() == null) return false;
        witnessIds.add(entry.witnessNodeId());
        return true;
    }

    private boolean isWithin(PsiIndex.Node node, PsiIndex.Node ancestor) {
        Integer owner = lexicalOwners.get(node.id());
        while (owner != null) {
            if (owner == ancestor.id()) return true;
            owner = lexicalOwners.get(owner);
        }
        return false;
    }

    private boolean isTopLevel(PsiIndex.Node node) {
        Integer owner = lexicalOwners.get(node.id());
        return owner != null && program.node(owner).kind() == PsiIndex.NodeKind.FILE;
    }

    private boolean isCallableDeclaration(PsiIndex.Node node) {
        return isTypeDeclaration(node) || node.kind() == PsiIndex.NodeKind.FUNCTION_DECL
            || node.kind() == PsiIndex.NodeKind.PROPERTY_DECL || node.kind() == PsiIndex.NodeKind.PARAMETER_DECL;
    }

    private boolean isDeclarationKind(PsiIndex.NodeKind kind) {
        return kind == PsiIndex.NodeKind.CLASS_DECL || kind == PsiIndex.NodeKind.INTERFACE_DECL
            || kind == PsiIndex.NodeKind.OBJECT_DECL || kind == PsiIndex.NodeKind.COMPANION_DECL
            || kind == PsiIndex.NodeKind.FUNCTION_DECL || kind == PsiIndex.NodeKind.PROPERTY_DECL
            || kind == PsiIndex.NodeKind.PARAMETER_DECL;
    }

    private boolean isTypeDeclaration(PsiIndex.Node node) {
        return node.kind() == PsiIndex.NodeKind.CLASS_DECL || node.kind() == PsiIndex.NodeKind.INTERFACE_DECL
            || node.kind() == PsiIndex.NodeKind.OBJECT_DECL || node.kind() == PsiIndex.NodeKind.COMPANION_DECL;
    }
}
